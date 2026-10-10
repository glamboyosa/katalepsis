import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
  ConfigurationError,
  copyEvidence,
  InvalidPreviewUrl,
  newRunId,
  parsePreviewUrl,
  PreviewProbe,
  previewUrlSecrets,
  redact,
  ReportWriteError,
  RunMetadata,
  SCHEMA_VERSION,
  VerificationRun,
  aggregateStatus,
  writeBundle,
  type PendingAttachment,
  type RunError,
  type VerificationCheck,
} from "@katalepsis/core";
import type { LanguageModel } from "ai";
import { Effect, Schema } from "effect";
import type { Browser } from "playwright-core";
import { launchAgentBrowser } from "./browser-install.ts";
import { CheckSession } from "./browser.ts";
import type { AgentCheck, ChecksFile } from "./checks.ts";
import { decideOutcome, type AssertionRecord, type Interruption, type Outcome } from "./outcome.ts";
import { runCheck, type Budget } from "./run-check.ts";

export type ModelSetup =
  | {
      readonly model: LanguageModel;
      readonly info: { readonly provider: string; readonly id: string };
      /** Values to redact everywhere, such as the API key. */
      readonly secrets: ReadonlyArray<string>;
    }
  | { readonly error: RunError };

export type AgentVerifyOptions = {
  readonly previewUrl: string;
  readonly checks: ChecksFile;
  /** Shown as each check's file in the report. */
  readonly checksFile: string;
  readonly cwd: string;
  readonly outDir: string;
  /** Origins the browser may visit besides the preview's own. */
  readonly extraOrigins: ReadonlyArray<string>;
  readonly budget: Budget;
  readonly environment: string;
  readonly toolVersion: string;
  readonly signal: AbortSignal;
  /** Resolves credentials and validates the model. Called only when the preview is reachable. */
  readonly setupModel: () => Promise<ModelSetup>;
  readonly launchBrowser?: () => Promise<Browser>;
};

type CheckResult = {
  readonly check: Omit<VerificationCheck, "evidence">;
  readonly attachments: ReadonlyArray<PendingAttachment>;
};

const SCRATCH = ".agent";
const playwrightVersion = (createRequire(import.meta.url)("playwright-core/package.json") as { version: string })
  .version;

const CANCELLED: RunError = {
  category: "infrastructure",
  message: "The run was cancelled before every check finished.",
  stage: "cancel",
  retryable: true,
};

const blockedCheck = (
  check: AgentCheck,
  checksFile: string,
  project: string,
  failure:
    | Interruption
    | { readonly code: "preview-unavailable" | "browser" | "interrupted"; readonly message: string },
): Omit<VerificationCheck, "evidence"> => ({
  id: check.id,
  source: "agent",
  title: check.name,
  titlePath: [check.name],
  file: checksFile,
  line: null,
  project,
  tags: [],
  expected: check.passCondition,
  observed: failure.message,
  status: "blocked",
  durationMs: 0,
  flaky: false,
  failure,
  attempts: [],
});

const assertionLine = (assertion: AssertionRecord): string =>
  `- ${assertion.id} ${assertion.passed ? "PASSED" : "FAILED"}: ${assertion.description} (${assertion.detail})`;

/** Lists every assertion that ran, cited ones first, so nothing the agent left out is hidden. */
const observedText = (
  outcome: Outcome,
  assertions: ReadonlyArray<AssertionRecord>,
  summary: string | null,
  steps: number,
  tokens: number,
): string => {
  const lines = [`${outcome.reason}`];
  const citedIds = new Set(outcome.cited.map((assertion) => assertion.id));
  if (outcome.cited.length > 0) lines.push("Cited assertions:", ...outcome.cited.map(assertionLine));
  const uncited = assertions.filter((assertion) => !citedIds.has(assertion.id));
  if (uncited.length > 0) lines.push("Other assertions it ran:", ...uncited.map(assertionLine));
  if (summary !== null && summary.trim() !== "") lines.push(`Agent summary, not evidence: ${summary.trim()}`);
  lines.push(`Used ${steps} model step(s) and ${tokens} tokens.`);
  return lines.join("\n");
};

/** Runs one check in a fresh browser context and collects its evidence. */
const verifyOne = async (
  browser: Browser,
  model: LanguageModel,
  check: AgentCheck,
  options: AgentVerifyOptions,
  startUrl: URL,
  allowedOrigins: ReadonlyArray<string>,
  scratchDir: string,
  project: string,
  secrets: ReadonlyArray<string>,
): Promise<CheckResult> => {
  const checkDir = path.join(scratchDir, check.id);
  await mkdir(checkDir, { recursive: true });
  const startedAt = new Date();
  const session = await CheckSession.open(browser, startUrl.href, allowedOrigins, checkDir);
  const traceFile = path.join(checkDir, "trace.zip");
  let run: Awaited<ReturnType<typeof runCheck>>;
  try {
    const startError = await session.start(check.startPath ?? startUrl.href);
    run =
      startError === null
        ? await runCheck(model, check, session, options.budget, options.signal)
        : { verdict: null, interruption: { code: "navigation", message: startError }, totalTokens: 0, steps: 0 };
  } catch (error) {
    // runCheck reports model errors itself, so this is a browser failure. Close the context first.
    await session.close(traceFile);
    throw error;
  }
  const interruption: Interruption | null =
    session.navigationViolation === null
      ? run.interruption
      : { code: "navigation", message: session.navigationViolation };
  const outcome = decideOutcome(run.verdict, session.assertions, interruption, check.observeOnly ?? false);

  const traced = await session.close(traceFile);
  const actionsFile = path.join(checkDir, "actions.json");
  await writeFile(
    actionsFile,
    redact(`${JSON.stringify({ actions: session.actions, verdict: run.verdict }, null, 2)}\n`, secrets),
  );
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();

  const attachments: Array<PendingAttachment> = [
    ...session.assertions.flatMap((assertion) => {
      const screenshot = session.screenshots.get(assertion.id);
      return screenshot === undefined
        ? []
        : [
            {
              checkId: check.id,
              retry: 0,
              name: `${assertion.id}-screenshot`,
              contentType: "image/png",
              kind: "screenshot" as const,
              sourcePath: screenshot,
              capturedAt: null,
            },
          ];
    }),
    ...(traced
      ? [
          {
            checkId: check.id,
            retry: 0,
            name: "trace",
            contentType: "application/zip",
            kind: "trace" as const,
            sourcePath: traceFile,
            capturedAt: finishedAt.toISOString(),
          },
        ]
      : []),
    {
      checkId: check.id,
      retry: 0,
      name: "actions",
      contentType: "application/json",
      kind: "log",
      sourcePath: actionsFile,
      capturedAt: finishedAt.toISOString(),
    },
  ];

  return {
    check: {
      id: check.id,
      source: "agent",
      title: check.name,
      titlePath: [check.name],
      file: options.checksFile,
      line: null,
      project,
      tags: [],
      expected: check.passCondition,
      observed: redact(
        observedText(outcome, session.assertions, run.verdict?.summary ?? null, run.steps, run.totalTokens),
        secrets,
      ),
      status: outcome.status,
      durationMs,
      flaky: false,
      failure:
        outcome.failure === null ? null : { ...outcome.failure, message: redact(outcome.failure.message, secrets) },
      attempts: [
        {
          retry: 0,
          status: outcome.status,
          durationMs,
          startedAt: startedAt.toISOString(),
          error: outcome.failure === null ? null : redact(outcome.failure.message, secrets),
        },
      ],
    },
    attachments,
  };
};

const scratchDirectory = (bundleDir: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdir(path.join(bundleDir, SCRATCH), { recursive: true }),
      catch: (cause) => new ReportWriteError({ message: `Could not create ${bundleDir}: ${String(cause)}` }),
    }),
    () => Effect.promise(() => rm(path.join(bundleDir, SCRATCH), { recursive: true, force: true })),
  );

const openBrowser = (launch: () => Promise<Browser>) =>
  Effect.acquireRelease(
    Effect.tryPromise({ try: launch, catch: (cause) => (cause instanceof Error ? cause.message : String(cause)) }),
    (browser) => Effect.promise(() => browser.close().catch(() => undefined)),
  );

/**
 * Runs agent checks against a preview and writes the same report bundle as Playwright runs.
 * Checks run one at a time, each in its own browser context. The model only proposes
 * actions and a verdict; `decideOutcome` turns browser assertions into the status.
 */
export const verifyWithAgent = (options: AgentVerifyOptions) =>
  Effect.gen(function* () {
    const probe = yield* PreviewProbe;
    const metadata = yield* RunMetadata;
    const preview = yield* Effect.try({
      try: () => parsePreviewUrl(options.previewUrl),
      catch: (error) =>
        new ConfigurationError({ message: error instanceof InvalidPreviewUrl ? error.message : String(error) }),
    });
    const extraOrigins = yield* Effect.try({
      try: () => options.extraOrigins.map((origin) => parsePreviewUrl(origin).origin),
      catch: (error) =>
        new ConfigurationError({
          message: `Invalid --allow-origin: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });
    const allowedOrigins = [preview.origin, ...extraOrigins];
    const startedAt = yield* metadata.now;
    const runId = newRunId(startedAt);
    const bundleDir = path.resolve(options.outDir, runId);
    const checks = options.checks.checks;

    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* scratchDirectory(bundleDir);
        const scratchDir = path.join(bundleDir, SCRATCH);
        const blockAll = (project: string, failure: Parameters<typeof blockedCheck>[3], error: RunError) => ({
          results: checks.map((check) => ({
            check: blockedCheck(check, options.checksFile, project, failure),
            attachments: [],
          })),
          errors: [error],
          model: null,
          secrets: previewUrlSecrets(preview),
        });

        const reachability = yield* probe.check(preview.raw, options.signal);
        if (options.signal.aborted) {
          return blockAll("agent", { code: "interrupted", message: "Not run: the run was cancelled." }, CANCELLED);
        }
        if (!reachability.reachable) {
          const message = `${preview.display} did not respond (${redact(reachability.reason, previewUrlSecrets(preview))}). No check was run.`;
          return blockAll(
            "agent",
            { code: "preview-unavailable", message },
            {
              category: "preview-unavailable",
              message,
              stage: "preview-probe",
              retryable: true,
            },
          );
        }

        const setup = yield* Effect.promise(() => options.setupModel());
        if ("error" in setup) return blockAll("agent", { code: "model", message: setup.error.message }, setup.error);
        const secrets = [...previewUrlSecrets(preview), ...setup.secrets];
        const project = `${setup.info.provider}/${setup.info.id}`;

        const browser = yield* Effect.result(
          openBrowser(options.launchBrowser ?? (() => launchAgentBrowser(process.env, options.signal))),
        );
        if (browser._tag === "Failure") {
          const message = `The browser could not start: ${redact(browser.failure, secrets)}`;
          return {
            ...blockAll(
              project,
              { code: "browser", message },
              { category: "browser", message, stage: "browser-launch", retryable: false },
            ),
            model: setup.info,
            secrets,
          };
        }

        const results: Array<CheckResult> = [];
        for (const check of checks) {
          if (options.signal.aborted) {
            results.push({
              check: blockedCheck(check, options.checksFile, project, {
                code: "interrupted",
                message: "Not run: the run was cancelled.",
              }),
              attachments: [],
            });
            continue;
          }
          results.push(
            yield* Effect.promise(() =>
              verifyOne(
                browser.success,
                setup.model,
                check,
                options,
                new URL(preview.raw),
                allowedOrigins,
                scratchDir,
                project,
                secrets,
              ).catch((error: unknown): CheckResult => ({
                check: blockedCheck(check, options.checksFile, project, {
                  code: "error",
                  message: redact(
                    `The check could not run: ${error instanceof Error ? error.message : String(error)}`,
                    secrets,
                  ),
                }),
                attachments: [],
              })),
            ),
          );
        }
        const copied = yield* copyEvidence(
          bundleDir,
          results.flatMap((result) => result.attachments),
          (yield* metadata.now).toISOString(),
        );
        return {
          results: results.map((result) => ({ check: result.check, attachments: result.attachments })),
          errors: options.signal.aborted ? [CANCELLED] : [],
          model: setup.info,
          secrets,
          evidence: copied.files,
          missing: copied.missing,
        };
      }),
    );

    const evidence = "evidence" in outcome ? outcome.evidence : [];
    const checkResults: Array<VerificationCheck> = outcome.results.map(({ check }) => ({
      ...check,
      evidence: evidence.filter((file) => file.checkId === check.id).map((file) => file.path),
    }));
    const commitSha = yield* metadata.commitSha(options.cwd);
    const repository = yield* metadata.repository(options.cwd);
    const finishedAt = yield* metadata.now;

    const run = yield* Schema.decodeUnknownEffect(VerificationRun)({
      schemaVersion: SCHEMA_VERSION,
      id: runId,
      previewUrl: preview.display,
      repository,
      commitSha,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      environment: options.environment,
      runner: { katalepsis: options.toolVersion, playwright: playwrightVersion, node: process.versions.node },
      model: outcome.model,
      status: aggregateStatus(checkResults, outcome.errors),
      declaredTests: checks.length,
      checks: checkResults,
      notTested: [],
      coverageLimitations: [
        "These are agent checks. A model chose the actions and which browser assertions to run; katalepsis decided each status from those assertions. Compare the cited assertions with each pass condition.",
        commitSha === null
          ? "Commit is unknown: the project directory is not a git checkout with a commit."
          : "Commit is the HEAD of the local checkout. katalepsis does not confirm that the preview was built from it.",
        `The browser could visit only ${[preview.origin, ...extraOrigins].join(", ")}.`,
        ...(evidence.length > 0
          ? [
              "Screenshots and traces are not redacted. They show whatever the page displayed. Use synthetic test data before sharing them.",
            ]
          : []),
        ...("missing" in outcome
          ? outcome.missing.map((item) => `Evidence for check ${item.checkId} was listed but missing: ${item.name}.`)
          : []),
      ],
      evidence,
      errors: outcome.errors,
    }).pipe(
      Effect.mapError(
        (error) => new ReportWriteError({ message: `Internal error: the run manifest is invalid. ${error.message}` }),
      ),
    );

    yield* writeBundle(bundleDir, run);
    return { run, bundleDir };
  });
