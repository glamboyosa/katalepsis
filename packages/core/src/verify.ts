import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Effect, Schema } from "effect";
import { ConfigurationError, PlaywrightProcessError, ReporterOutputError, ReportWriteError } from "./errors.ts";
import { copyEvidence, writeRunLog } from "./evidence.ts";
import { declaredTests, normalizePlaywrightReport, type DeclaredTest } from "./playwright-report.ts";
import { PlaywrightRunner, type PlaywrightSelection } from "./playwright-runner.ts";
import { PreviewProbe } from "./preview-probe.ts";
import { newRunId, writeBundle } from "./bundle.ts";
import { RunMetadata } from "./run-metadata.ts";
import {
  InvalidPreviewUrl,
  parsePreviewUrl,
  previewUrlSecrets,
  redact,
  stripAnsi,
  type PreviewUrl,
} from "./sanitize.ts";
import { aggregateStatus } from "./status.ts";
import {
  SCHEMA_VERSION,
  VerificationRun,
  type EvidenceFile,
  type NotTested,
  type RunError,
  type VerificationCheck,
} from "./schema.ts";

export type VerifyOptions = {
  readonly previewUrl: string;
  readonly cwd: string;
  /** Directory that receives one sub-directory per run. */
  readonly outDir: string;
  readonly config: string | null;
  readonly projects: ReadonlyArray<string>;
  readonly grep: string | null;
  readonly timeoutMs: number;
  /** Run the project's own `playwright install` before the tests. */
  readonly installBrowsers?: boolean;
  readonly environment: string;
  readonly toolVersion: string;
  /** Aborting it stops Playwright; the run is then reported as blocked. */
  readonly signal: AbortSignal;
};

export type VerifyOutcome = { readonly run: VerificationRun; readonly bundleDir: string };

type CheckWithoutEvidence = Omit<VerificationCheck, "evidence">;

type Execution = {
  readonly checks: ReadonlyArray<CheckWithoutEvidence>;
  readonly notTested: ReadonlyArray<NotTested>;
  readonly errors: ReadonlyArray<RunError>;
  readonly evidence: ReadonlyArray<EvidenceFile>;
  readonly limitations: ReadonlyArray<string>;
  /** IDs Playwright reported a result for, or that were reported as blocked without running. */
  readonly accountedIds: ReadonlySet<string>;
  /** False when Playwright never ran the tests, so a missing result is expected, not suspicious. */
  readonly ranPlaywright: boolean;
};

type Listing = { readonly tests: ReadonlyArray<DeclaredTest>; readonly error: RunError | null };

const OUTPUT_TAIL_LINES = 8;
const SCRATCH = ".playwright";

const titleOf = (test: DeclaredTest): string => test.titlePath.join(" › ");

/** The last non-empty lines of Playwright's output, for an error message. */
const outputTail = (output: string): string =>
  stripAnsi(output)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-OUTPUT_TAIL_LINES)
    .join("\n");

const processError = (
  error: PlaywrightProcessError | ReporterOutputError,
  stage: string,
  secrets: ReadonlyArray<string>,
): RunError => {
  const tail = outputTail(error.output);
  return {
    category: "infrastructure",
    message: redact(tail === "" ? error.message : `${error.message}\nPlaywright output:\n${tail}`, secrets),
    stage,
    retryable: error._tag === "PlaywrightProcessError" && error.retryable,
  };
};

const blockedCheck = (test: DeclaredTest, reason: string): CheckWithoutEvidence => ({
  id: test.id,
  source: "playwright-test",
  title: test.titlePath.at(-1) ?? "",
  titlePath: test.titlePath,
  file: test.file,
  line: test.line,
  project: test.project,
  tags: [],
  expected: "Test passes",
  observed: reason,
  status: "blocked",
  durationMs: 0,
  flaky: false,
  failure: { code: "preview-unavailable", message: reason },
  attempts: [],
});

const EVIDENCE_SETTINGS: ReadonlyArray<readonly [EvidenceFile["kind"], string]> = [
  ["screenshot", `screenshot: "only-on-failure"`],
  ["trace", `trace: "retain-on-failure"`],
  ["video", `video: "retain-on-failure"`],
];

const evidenceLimitations = (
  checks: ReadonlyArray<CheckWithoutEvidence>,
  evidence: ReadonlyArray<EvidenceFile>,
): Array<string> => {
  const problems = checks.filter((check) => check.status !== "passed" && check.attempts.length > 0);
  return EVIDENCE_SETTINGS.flatMap(([kind, setting]) => {
    const count = problems.filter(
      (check) => !evidence.some((file) => file.checkId === check.id && file.kind === kind),
    ).length;
    return count === 0
      ? []
      : [
          `${count} failed or blocked check(s) have no ${kind}. Set use.${setting} in the Playwright config to capture one.`,
        ];
  });
};

/** Runs the selected tests against a reachable preview and collects their evidence. */
const executeTests = (
  options: VerifyOptions,
  selection: PlaywrightSelection,
  preview: PreviewUrl,
  bundleDir: string,
  secrets: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const runner = yield* PlaywrightRunner;
    const metadata = yield* RunMetadata;
    const scratchDir = path.join(bundleDir, SCRATCH);
    const result = yield* Effect.result(
      runner.run({
        ...selection,
        outputDir: path.join(scratchDir, "output"),
        jsonFile: path.join(scratchDir, "report.json"),
        timeoutMs: options.timeoutMs,
      }),
    );
    const finishedAt = (yield* metadata.now).toISOString();
    const output = result._tag === "Success" ? result.success.output : result.failure.output;
    const log = yield* writeRunLog(bundleDir, "evidence/run/playwright.log", redact(output, secrets), finishedAt);

    if (result._tag === "Failure") {
      return {
        checks: [],
        notTested: [],
        errors: [processError(result.failure, "playwright-run", secrets)],
        evidence: [log],
        limitations: [],
        accountedIds: new Set<string>(),
        ranPlaywright: true,
      } satisfies Execution;
    }

    const normalized = normalizePlaywrightReport(result.success.report, { secrets, previewOrigin: preview.origin });
    const copied = yield* copyEvidence(bundleDir, normalized.attachments, finishedAt);
    const limitations = [
      ...evidenceLimitations(normalized.checks, copied.files),
      ...copied.missing.map(
        (item) =>
          `Playwright listed a ${item.kind} for check ${item.checkId} (retry ${item.retry}) but the file was missing.`,
      ),
      ...(normalized.skippedInlineAttachments > 0
        ? [
            `${normalized.skippedInlineAttachments} inline attachment(s) were not copied; only file attachments are bundled.`,
          ]
        : []),
      ...(normalized.checks.some((check) => check.flaky)
        ? ["Some checks passed only after a retry. Their earlier failed attempts are listed with the check."]
        : []),
    ];
    return {
      checks: normalized.checks,
      notTested: normalized.notTested,
      errors: normalized.errors,
      evidence: [...copied.files, log],
      limitations,
      accountedIds: new Set(normalized.checks.map((check) => check.id)),
      ranPlaywright: true,
    } satisfies Execution;
  });

const CANCELLED: RunError = {
  category: "infrastructure",
  message: "The run was cancelled before Playwright finished.",
  stage: "cancel",
  retryable: true,
};

const NO_RESULT = "Selected, but Playwright reported no result";

/** An execution in which Playwright did not run. */
const notRun = (errors: ReadonlyArray<RunError>): Execution => ({
  checks: [],
  notTested: [],
  errors,
  evidence: [],
  limitations: [],
  accountedIds: new Set<string>(),
  ranPlaywright: false,
});

/** Reports every selected test as blocked because the preview did not answer. */
const blockedExecution = (selected: ReadonlyArray<DeclaredTest>, preview: PreviewUrl, reason: string): Execution => {
  const runnable = selected.filter((test) => test.skipReason === null);
  return {
    checks: runnable.map((test) => blockedCheck(test, `Preview did not respond: ${reason}`)),
    notTested: [],
    errors: [
      {
        category: "preview-unavailable",
        message: `${preview.display} did not respond (${reason}). Playwright was not run.`,
        stage: "preview-probe",
        retryable: true,
      },
    ],
    evidence: [],
    limitations: [],
    accountedIds: new Set(runnable.map((test) => test.id)),
    ranPlaywright: false,
  };
};

/** Lists declared tests; a listing failure becomes a run error and a log instead of aborting. */
const listTests = (
  selection: PlaywrightSelection,
  bundleDir: string,
  name: string,
  secrets: ReadonlyArray<string>,
  capturedAt: string,
) =>
  Effect.gen(function* () {
    const runner = yield* PlaywrightRunner;
    const result = yield* Effect.result(
      runner.list({ ...selection, jsonFile: path.join(bundleDir, SCRATCH, `${name}.json`) }),
    );
    if (result._tag === "Success") {
      return { listing: { tests: declaredTests(result.success), error: null } satisfies Listing, log: null };
    }
    const log = yield* writeRunLog(
      bundleDir,
      `evidence/run/${name}.log`,
      redact(result.failure.output, secrets),
      capturedAt,
    );
    return {
      listing: { tests: [], error: processError(result.failure, "playwright-list", secrets) } satisfies Listing,
      log,
    };
  });

const asNotTested = (test: DeclaredTest, reason: string): NotTested => ({
  title: titleOf(test),
  file: test.file,
  project: test.project,
  reason,
});

const notTestedFor = (all: Listing, selected: Listing, execution: Execution): Array<NotTested> => {
  const selectedIds = new Set(selected.tests.map((test) => test.id));
  const reported = new Set(execution.notTested.map((item) => `${item.project}\u0000${item.file}\u0000${item.title}`));
  const isReported = (test: DeclaredTest) => reported.has(`${test.project}\u0000${test.file}\u0000${titleOf(test)}`);
  return [
    ...execution.notTested,
    ...all.tests
      .filter((test) => !selectedIds.has(test.id))
      .map((test) => asNotTested(test, "Excluded by the --project or --grep filter")),
    ...selected.tests
      .filter((test) => !execution.accountedIds.has(test.id) && !isReported(test))
      .map((test) =>
        asNotTested(
          test,
          test.skipReason ??
            (execution.ranPlaywright ? NO_RESULT : "Not run: the run stopped before Playwright started"),
        ),
      ),
  ];
};

/** Creates the bundle directory and removes Playwright's scratch output when the run ends, however it ends. */
const bundleDirectory = (bundleDir: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdir(path.join(bundleDir, SCRATCH), { recursive: true }),
      catch: (cause) => new ReportWriteError({ message: `Could not create ${bundleDir}: ${String(cause)}` }),
    }),
    () => Effect.promise(() => rm(path.join(bundleDir, SCRATCH), { recursive: true, force: true })),
  );

/**
 * Verifies a preview with the project's existing Playwright tests and writes a report
 * bundle. Test outcomes come from Playwright only. If the preview cannot be reached,
 * the selected tests are reported as blocked and Playwright is not run.
 */
export const verifyWithPlaywright = (options: VerifyOptions) =>
  Effect.gen(function* () {
    const runner = yield* PlaywrightRunner;
    const probe = yield* PreviewProbe;
    const metadata = yield* RunMetadata;

    const preview = yield* Effect.try({
      try: () => parsePreviewUrl(options.previewUrl),
      catch: (error) =>
        new ConfigurationError({ message: error instanceof InvalidPreviewUrl ? error.message : String(error) }),
    });
    const secrets = previewUrlSecrets(preview);
    const install = yield* runner.locate(options.cwd);
    const startedAt = yield* metadata.now;
    const runId = newRunId(startedAt);
    const bundleDir = path.resolve(options.outDir, runId);

    const { run } = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* bundleDirectory(bundleDir);
        const selection: PlaywrightSelection = {
          cwd: options.cwd,
          install,
          config: options.config,
          projects: options.projects,
          grep: options.grep,
          baseUrl: preview.raw,
          signal: options.signal,
        };
        const filtered = options.projects.length > 0 || options.grep !== null;
        const startedIso = startedAt.toISOString();
        const installError: RunError | null =
          options.installBrowsers === true
            ? yield* runner.installBrowsers(options.cwd, install, options.signal).pipe(
                Effect.as(null),
                Effect.catch((error) =>
                  Effect.succeed<RunError>({ ...processError(error, "browser-install", secrets), category: "browser" }),
                ),
              )
            : null;
        const selected = yield* listTests(selection, bundleDir, "list-selected", secrets, startedIso);
        const listFailed = selected.listing.error !== null;
        const listAll = filtered && !listFailed && !options.signal.aborted;
        const all = listAll
          ? yield* listTests({ ...selection, projects: [], grep: null }, bundleDir, "list-all", secrets, startedIso)
          : selected;

        // A failed selected listing already explains the run, and a cancelled run gets one
        // cancellation error, so neither starts another Playwright process. A failed unfiltered
        // listing only loses the list of excluded tests, so the selected tests still run.
        const probeAndRun = Effect.gen(function* () {
          const reachability = yield* probe.check(preview.raw, options.signal);
          if (options.signal.aborted) return notRun([CANCELLED]);
          return reachability.reachable
            ? yield* executeTests(options, selection, preview, bundleDir, secrets)
            : blockedExecution(selected.listing.tests, preview, redact(reachability.reason, secrets));
        });
        const execution: Execution = listFailed
          ? notRun([])
          : options.signal.aborted
            ? notRun(all.listing.error === null ? [CANCELLED] : [])
            : yield* probeAndRun;

        const commitSha = yield* metadata.commitSha(options.cwd);
        const repository = yield* metadata.repository(options.cwd);
        const finishedAt = yield* metadata.now;

        const notTested = notTestedFor(all.listing, selected.listing, execution);
        const unreported = notTested.filter((item) => item.reason === NO_RESULT).length;
        const listErrors = listAll ? [selected.listing.error, all.listing.error] : [selected.listing.error];
        const errors = [
          ...(installError === null ? [] : [installError]),
          ...listErrors.filter((error) => error !== null),
          ...execution.errors,
          // Tests that were listed but never reported are not a deliberate gap, so they block the run.
          ...(unreported > 0 && execution.errors.length === 0
            ? [
                {
                  category: "infrastructure" as const,
                  message: `${unreported} selected test(s) were listed, but Playwright reported no result for them.`,
                  stage: "playwright-run",
                  retryable: false,
                },
              ]
            : []),
        ];
        const listLogs = [selected.log, listAll ? all.log : null].filter((log) => log !== null);
        const evidence = [...execution.evidence, ...listLogs];
        const checks: Array<VerificationCheck> = execution.checks.map((check) => ({
          ...check,
          evidence: evidence.filter((file) => file.checkId === check.id).map((file) => file.path),
        }));

        return yield* Schema.decodeUnknownEffect(VerificationRun)({
          schemaVersion: SCHEMA_VERSION,
          id: runId,
          previewUrl: preview.display,
          repository,
          commitSha,
          startedAt: startedIso,
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          environment: options.environment,
          runner: { katalepsis: options.toolVersion, playwright: install.version, node: process.versions.node },
          model: null,
          status: aggregateStatus(checks, errors),
          declaredTests: all.listing.tests.length,
          checks,
          notTested,
          coverageLimitations: [
            "katalepsis passes the preview URL to Playwright as KATALEPSIS_BASE_URL. It cannot confirm that the Playwright config reads it.",
            commitSha === null
              ? "Commit is unknown: the project directory is not a git checkout with a commit."
              : "Commit is the HEAD of the local checkout. katalepsis does not confirm that the preview was built from it.",
            "Only the project's Playwright tests were checked. Behaviour without a test is not covered.",
            ...(evidence.some((file) => file.checkId !== null)
              ? [
                  "Screenshots, videos and traces are not redacted. They can show the preview URL, cookies and values typed into the page. Use synthetic test data before sharing them.",
                ]
              : []),
            ...execution.limitations,
            ...(checks.some((check) => check.failure?.code === "browser")
              ? [
                  "A browser could not start. Run again with --install-browsers to install the browsers this project's Playwright version needs.",
                ]
              : []),
          ],
          evidence,
          errors,
        }).pipe(
          Effect.map((validated) => ({ run: validated })),
          Effect.mapError(
            (error) =>
              new ReportWriteError({ message: `Internal error: the run manifest is invalid. ${error.message}` }),
          ),
        );
      }),
    );

    yield* writeBundle(bundleDir, run);
    return { run, bundleDir } satisfies VerifyOutcome;
  });
