import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Layer, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PlaywrightProcessError,
  ReporterOutputError,
  PlaywrightRunner,
  PreviewProbe,
  RunMetadata,
  VerificationRun,
  verifyWithPlaywright,
  type PlaywrightJsonReport,
  type PlaywrightSelection,
  type ProbeResult,
  type VerifyOptions,
} from "../src/index.ts";
import { report, result, test } from "./report-builders.ts";

let outDir: string;
beforeEach(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "katalepsis-verify-"));
});
afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

const SECRET = "bypass-s3cr3t-token";

const options = (overrides: Partial<VerifyOptions> = {}): VerifyOptions => ({
  previewUrl: `https://preview.example.com/?x-vercel-protection-bypass=${SECRET}`,
  cwd: "/project",
  outDir,
  config: null,
  projects: [],
  grep: null,
  timeoutMs: 60_000,
  environment: "test",
  toolVersion: "0.0.0-test",
  signal: new AbortController().signal,
  ...overrides,
});

const listing = report([
  { title: "signs up", tests: [test({ status: "skipped", results: [] })] },
  { title: "rejects a bad email", tests: [test({ status: "skipped", results: [] })] },
]);

type FakeRunner = {
  listed?: PlaywrightJsonReport;
  listedFiltered?: PlaywrightJsonReport;
  run?: () => Effect.Effect<PlaywrightJsonReport, PlaywrightProcessError>;
  list?: (selection: PlaywrightSelection) => Effect.Effect<PlaywrightJsonReport, ReporterOutputError>;
};

const layers = (fake: FakeRunner, probe: ProbeResult = { reachable: true }) => {
  const calls = { run: 0, baseUrls: [] as Array<string>, listBaseUrls: [] as Array<string> };
  const layer = Layer.mergeAll(
    Layer.succeed(PlaywrightRunner, {
      locate: () => Effect.succeed({ cliPath: "/fake/cli.js", version: "1.63.0" }),
      list: (selection) => {
        calls.listBaseUrls.push(selection.baseUrl);
        if (fake.list) return fake.list(selection);
        return Effect.succeed(selection.grep === null ? (fake.listed ?? listing) : (fake.listedFiltered ?? listing));
      },
      run: (runOptions) => {
        calls.run += 1;
        calls.baseUrls.push(runOptions.baseUrl);
        return (fake.run?.() ?? Effect.succeed(report([]))).pipe(
          Effect.map((output) => ({ report: output, exitCode: 1, output: `GET ${runOptions.baseUrl}` })),
        );
      },
    }),
    Layer.succeed(PreviewProbe, { check: () => Effect.succeed(probe) }),
    Layer.succeed(RunMetadata, {
      now: Effect.succeed(new Date("2026-01-01T00:00:00.000Z")),
      commitSha: () => Effect.succeed(null),
      repository: () => Effect.succeed(null),
    }),
  );
  return { layer, calls };
};

const bundleText = async (bundleDir: string): Promise<string> => {
  const files = await readdir(bundleDir, { recursive: true, withFileTypes: true });
  const texts = await Promise.all(
    files.filter((entry) => entry.isFile()).map((entry) => readFile(path.join(entry.parentPath, entry.name), "utf8")),
  );
  return texts.join("\n");
};

describe("verifyWithPlaywright", () => {
  it("reports Playwright's outcome, bundles evidence and never persists the preview token", async () => {
    const screenshot = path.join(outDir, "source-failure.png");
    await writeFile(screenshot, "png");
    const executed = report([
      { title: "signs up", tests: [test()] },
      {
        title: "rejects a bad email",
        tests: [
          test({
            status: "unexpected",
            results: [
              result({
                status: "failed",
                error: {
                  message: `expect(page).toHaveURL failed: https://preview.example.com/?x-vercel-protection-bypass=${SECRET}`,
                },
                attachments: [{ name: "screenshot", contentType: "image/png", path: screenshot }],
              }),
            ],
          }),
        ],
      },
    ]);
    const { layer, calls } = layers({ run: () => Effect.succeed(executed) });

    const outcome = await Effect.runPromise(verifyWithPlaywright(options()).pipe(Effect.provide(layer)));

    expect(calls.baseUrls).toEqual([`https://preview.example.com/?x-vercel-protection-bypass=${SECRET}`]);
    expect(outcome.run.status).toBe("failed");
    expect(outcome.run.checks.map((check) => check.status)).toEqual(["passed", "failed"]);
    expect(outcome.run.checks[1]?.evidence).toEqual([
      expect.stringMatching(/^evidence\/[a-f0-9]{12}\/retry-0-screenshot\.png$/),
    ]);
    expect(outcome.run.commitSha).toBeNull();

    const manifest = JSON.parse(await readFile(path.join(outcome.bundleDir, "manifest.json"), "utf8"));
    expect(Schema.decodeUnknownSync(VerificationRun)(manifest).id).toBe(outcome.run.id);
    const persisted = await bundleText(outcome.bundleDir);
    expect(persisted).not.toContain(SECRET);
    expect(persisted).toContain("x-vercel-protection-bypass=REDACTED");
  });

  it("blocks every selected test without running Playwright when the preview is down", async () => {
    const { layer, calls } = layers({}, { reachable: false, reason: "connect ECONNREFUSED 127.0.0.1:4173" });

    const outcome = await Effect.runPromise(verifyWithPlaywright(options()).pipe(Effect.provide(layer)));

    expect(calls.run).toBe(0);
    expect(outcome.run.status).toBe("blocked");
    expect(outcome.run.checks.map((check) => [check.title, check.status, check.failure?.code])).toEqual([
      ["signs up", "blocked", "preview-unavailable"],
      ["rejects a bad email", "blocked", "preview-unavailable"],
    ]);
    expect(outcome.run.errors.map((error) => error.category)).toEqual(["preview-unavailable"]);
    const markdown = await readFile(path.join(outcome.bundleDir, "report.md"), "utf8");
    expect(markdown).toContain("Playwright was not run, so no declared test ran.");
    expect(markdown).not.toContain("Every declared test ran.");
  });

  it("lists tests with the preview URL set, so the config declares the same tests as the run", async () => {
    const { layer, calls } = layers({ run: () => Effect.succeed(report([{ title: "signs up", tests: [test()] }])) });
    await Effect.runPromise(verifyWithPlaywright(options()).pipe(Effect.provide(layer)));
    expect(calls.listBaseUrls).toEqual([`https://preview.example.com/?x-vercel-protection-bypass=${SECRET}`]);
  });

  it("does not run Playwright or invent filter exclusions when the selected listing fails", async () => {
    const { layer, calls } = layers({
      list: (selection) =>
        selection.projects.length > 0
          ? Effect.fail(
              new ReporterOutputError({
                message: "Playwright did not write a JSON report.",
                output: 'Project(s) "nope" not found.',
              }),
            )
          : Effect.succeed(listing),
    });

    const outcome = await Effect.runPromise(
      verifyWithPlaywright(options({ projects: ["nope"] })).pipe(Effect.provide(layer)),
    );

    expect(calls.run).toBe(0);
    expect(outcome.run.status).toBe("blocked");
    expect(outcome.run.errors.map((error) => error.stage)).toEqual(["playwright-list"]);
    expect(outcome.run.notTested).toEqual([]);
  });

  it("still runs the selected tests when only the unfiltered listing fails", async () => {
    const { layer, calls } = layers({
      list: (selection) =>
        selection.grep === null
          ? Effect.fail(new ReporterOutputError({ message: "Playwright did not write a JSON report.", output: "" }))
          : Effect.succeed(report([{ title: "signs up", tests: [test({ status: "skipped", results: [] })] }])),
      run: () => Effect.succeed(report([{ title: "signs up", tests: [test()] }])),
    });

    const outcome = await Effect.runPromise(
      verifyWithPlaywright(options({ grep: "signs up" })).pipe(Effect.provide(layer)),
    );

    expect(calls.run).toBe(1);
    expect(outcome.run.checks.map((check) => check.status)).toEqual(["passed"]);
    expect(outcome.run.errors.map((error) => error.stage)).toEqual(["playwright-list"]);
  });

  it("stops with a single cancellation error when cancelled before Playwright runs", async () => {
    const controller = new AbortController();
    const { layer, calls } = layers({
      list: () => Effect.sync(() => controller.abort()).pipe(Effect.as(listing)),
    });

    const outcome = await Effect.runPromise(
      verifyWithPlaywright(options({ grep: "signs up", signal: controller.signal })).pipe(Effect.provide(layer)),
    );

    expect(calls.run).toBe(0);
    expect(calls.listBaseUrls).toHaveLength(1);
    expect(outcome.run.status).toBe("blocked");
    expect(outcome.run.errors.map((error) => error.message)).toEqual([
      "The run was cancelled before Playwright finished.",
    ]);
  });

  it("blocks a run in which a listed test got no result from Playwright", async () => {
    const { layer } = layers({ run: () => Effect.succeed(report([{ title: "signs up", tests: [test()] }])) });

    const outcome = await Effect.runPromise(verifyWithPlaywright(options()).pipe(Effect.provide(layer)));

    expect(outcome.run.checks.map((check) => check.status)).toEqual(["passed"]);
    expect(outcome.run.status).toBe("blocked");
    expect(outcome.run.errors.map((error) => error.message)).toEqual([
      "1 selected test(s) were listed, but Playwright reported no result for them.",
    ]);
  });

  it("blocks the run, keeps Playwright's output and lists unreported tests when Playwright cannot finish", async () => {
    const { layer } = layers({
      run: () =>
        Effect.fail(
          new PlaywrightProcessError({
            message: "Playwright did not finish within 60s",
            retryable: true,
            output: `Running 2 tests using 1 worker\nGET https://preview.example.com/?x-vercel-protection-bypass=${SECRET}`,
          }),
        ),
    });

    const outcome = await Effect.runPromise(verifyWithPlaywright(options()).pipe(Effect.provide(layer)));

    expect(outcome.run.status).toBe("blocked");
    expect(outcome.run.errors).toEqual([
      {
        category: "infrastructure",
        message:
          "Playwright did not finish within 60s\nPlaywright output:\nRunning 2 tests using 1 worker\nGET https://preview.example.com/?x-vercel-protection-bypass=[REDACTED]",
        stage: "playwright-run",
        retryable: true,
      },
    ]);
    expect(outcome.run.evidence.map((file) => file.path)).toEqual(["evidence/run/playwright.log"]);
    expect(await readFile(path.join(outcome.bundleDir, "evidence/run/playwright.log"), "utf8")).toContain(
      "Running 2 tests",
    );
    expect(outcome.run.notTested.map((item) => item.reason)).toEqual([
      "Selected, but Playwright reported no result",
      "Selected, but Playwright reported no result",
    ]);
  });

  it("writes a blocked report and removes scratch files when the run is cancelled", async () => {
    const controller = new AbortController();
    const { layer } = layers({
      run: () =>
        Effect.sync(() => controller.abort()).pipe(
          Effect.andThen(
            Effect.fail(
              new PlaywrightProcessError({
                message: "The run was cancelled before Playwright finished.",
                retryable: true,
                output: "",
              }),
            ),
          ),
        ),
    });

    const outcome = await Effect.runPromise(
      verifyWithPlaywright(options({ signal: controller.signal })).pipe(Effect.provide(layer)),
    );

    expect(outcome.run.status).toBe("blocked");
    expect(outcome.run.errors[0]?.message).toBe("The run was cancelled before Playwright finished.");
    expect((await readdir(outcome.bundleDir)).toSorted()).toEqual([
      "evidence",
      "manifest.json",
      "report.html",
      "report.md",
    ]);
  });

  it("lists tests skipped at declaration as not tested when the preview is down", async () => {
    const { layer } = layers(
      {
        listed: report([
          { title: "signs up", tests: [test({ status: "skipped", results: [] })] },
          {
            title: "pays by card",
            tests: [test({ status: "skipped", annotations: [{ type: "fixme" }], results: [] })],
          },
        ]),
      },
      { reachable: false, reason: "connect ECONNREFUSED" },
    );

    const outcome = await Effect.runPromise(verifyWithPlaywright(options()).pipe(Effect.provide(layer)));

    expect(outcome.run.checks.map((check) => [check.title, check.line])).toEqual([["signs up", 1]]);
    expect(outcome.run.notTested).toEqual([
      { title: "pays by card", file: "checkout.spec.ts", project: "chromium", reason: "Skipped by test.fixme()" },
    ]);
  });

  it("records a listing failure once, with its log, and does not claim every test ran", async () => {
    const failingList = Effect.fail(
      new ReporterOutputError({
        message: "Playwright did not write a JSON report.",
        output: "Error: Cannot find module 'playwright.config.ts'",
      }),
    );
    const base = layers({ run: () => Effect.succeed(report([], [{ message: "Error: No tests found" }])) });
    const layer = Layer.merge(
      base.layer,
      Layer.succeed(PlaywrightRunner, {
        locate: () => Effect.succeed({ cliPath: "/fake/cli.js", version: "1.63.0" }),
        list: () => failingList,
        run: () => Effect.succeed({ report: report([]), exitCode: 1, output: "" }),
      }),
    );

    const outcome = await Effect.runPromise(verifyWithPlaywright(options()).pipe(Effect.provide(layer)));

    expect(outcome.run.errors.filter((error) => error.stage === "playwright-list")).toHaveLength(1);
    expect(outcome.run.evidence.map((file) => file.path)).toContain("evidence/run/list-selected.log");
    const markdown = await readFile(path.join(outcome.bundleDir, "report.md"), "utf8");
    expect(markdown).not.toContain("Every declared test ran.");
    expect(markdown).toContain("Playwright could not list the declared tests");
  });

  it("treats a run that matched no tests as blocked, not passed", async () => {
    const { layer } = layers({
      listed: report([]),
      run: () => Effect.succeed(report([], [{ message: "Error: No tests found" }])),
    });

    const outcome = await Effect.runPromise(verifyWithPlaywright(options()).pipe(Effect.provide(layer)));

    expect(outcome.run.status).toBe("blocked");
    expect(outcome.run.checks).toEqual([]);
  });

  it("lists tests excluded by --grep as not tested", async () => {
    const { layer } = layers({
      listedFiltered: report([{ title: "signs up", tests: [test({ status: "skipped", results: [] })] }]),
      run: () => Effect.succeed(report([{ title: "signs up", tests: [test()] }])),
    });

    const outcome = await Effect.runPromise(
      verifyWithPlaywright(options({ grep: "signs up" })).pipe(Effect.provide(layer)),
    );

    expect(outcome.run.status).toBe("passed");
    expect(outcome.run.declaredTests).toBe(2);
    expect(outcome.run.notTested).toEqual([
      {
        title: "rejects a bad email",
        file: "checkout.spec.ts",
        project: "chromium",
        reason: "Excluded by the --project or --grep filter",
      },
    ]);
  });

  it("refuses a preview URL with credentials before writing anything", async () => {
    const { layer } = layers({});

    const failure = await Effect.runPromise(
      Effect.flip(
        verifyWithPlaywright(options({ previewUrl: "https://user:pw@preview.example.com" })).pipe(
          Effect.provide(layer),
        ),
      ),
    );

    expect(failure._tag).toBe("ConfigurationError");
    expect(await readdir(outDir)).toEqual([]);
  });
});
