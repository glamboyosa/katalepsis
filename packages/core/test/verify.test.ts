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
  install?: () => Effect.Effect<string, PlaywrightProcessError>;
  /** Makes the run look cancelled or timed out after Playwright wrote a partial report. */
  stoppedBy?: PlaywrightProcessError;
};

const layers = (
  fake: FakeRunner,
  probe: ProbeResult = { reachable: true, commit: null },
  checkout: string | null = null,
) => {
  const calls = { run: 0, installs: 0, baseUrls: [] as Array<string>, listBaseUrls: [] as Array<string> };
  const layer = Layer.mergeAll(
    Layer.succeed(PlaywrightRunner, {
      locate: () => Effect.succeed({ cliPath: "/fake/cli.js", version: "1.63.0" }),
      installBrowsers: () => {
        calls.installs += 1;
        return fake.install?.() ?? Effect.succeed("installed");
      },
      list: (selection) => {
        calls.listBaseUrls.push(selection.baseUrl);
        if (fake.list) return fake.list(selection);
        return Effect.succeed(selection.grep === null ? (fake.listed ?? listing) : (fake.listedFiltered ?? listing));
      },
      run: (runOptions) => {
        calls.run += 1;
        calls.baseUrls.push(runOptions.baseUrl);
        return (fake.run?.() ?? Effect.succeed(report([]))).pipe(
          Effect.map((output) => ({
            report: output,
            exitCode: 1,
            output: `GET ${runOptions.baseUrl}`,
            stoppedBy: fake.stoppedBy ?? null,
          })),
        );
      },
    }),
    Layer.succeed(PreviewProbe, { check: () => Effect.succeed(probe) }),
    Layer.succeed(RunMetadata, {
      now: Effect.succeed(new Date("2026-01-01T00:00:00.000Z")),
      commitSha: () => Effect.succeed(checkout),
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

  it("installs browsers first only when asked", async () => {
    const { layer, calls } = layers({ run: () => Effect.succeed(report([{ title: "signs up", tests: [test()] }])) });
    await Effect.runPromise(verifyWithPlaywright(options()).pipe(Effect.provide(layer)));
    expect(calls.installs).toBe(0);
    await Effect.runPromise(verifyWithPlaywright(options({ installBrowsers: true })).pipe(Effect.provide(layer)));
    expect(calls.installs).toBe(1);
  });

  it("records a failed browser install as a browser error and still runs the tests", async () => {
    const { layer, calls } = layers({
      install: () =>
        Effect.fail(
          new PlaywrightProcessError({
            message: "playwright install exited with code 1.",
            retryable: true,
            output: "",
          }),
        ),
      run: () =>
        Effect.succeed(
          report([
            { title: "signs up", tests: [test()] },
            { title: "rejects a bad email", tests: [test()] },
          ]),
        ),
    });
    const outcome = await Effect.runPromise(
      verifyWithPlaywright(options({ installBrowsers: true })).pipe(Effect.provide(layer)),
    );
    expect(calls.run).toBe(1);
    expect(outcome.run.errors).toEqual([
      {
        category: "browser",
        message: "playwright install exited with code 1.",
        stage: "browser-install",
        retryable: true,
      },
    ]);
  });

  it("tells you how to install browsers when one could not start", async () => {
    const { layer } = layers({
      run: () =>
        Effect.succeed(
          report([
            {
              title: "signs up",
              tests: [
                test({
                  status: "unexpected",
                  results: [
                    result({
                      status: "failed",
                      error: { message: "browserType.launch: Executable doesn't exist at /x" },
                    }),
                  ],
                }),
              ],
            },
            { title: "rejects a bad email", tests: [test()] },
          ]),
        ),
    });
    const outcome = await Effect.runPromise(verifyWithPlaywright(options()).pipe(Effect.provide(layer)));
    expect(outcome.run.coverageLimitations.join("\n")).toContain("--install-browsers");
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

  it("says when the Playwright config never mentions KATALEPSIS_BASE_URL", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "katalepsis-config-"));
    const limitation = async (config: string) => {
      await writeFile(path.join(project, "playwright.config.ts"), config);
      const { layer } = layers({ run: () => Effect.succeed(report([{ title: "signs up", tests: [test()] }])) });
      const outcome = await Effect.runPromise(
        verifyWithPlaywright(options({ cwd: project })).pipe(Effect.provide(layer)),
      );
      return outcome.run.coverageLimitations[0];
    };
    try {
      expect(await limitation('export default { use: { baseURL: "http://localhost:3000" } };')).toContain(
        "playwright.config.ts does not mention KATALEPSIS_BASE_URL, so the tests may have run against a baseURL set in that config",
      );
      expect(await limitation("export default { use: { baseURL: process.env.KATALEPSIS_BASE_URL } };")).toBe(
        "katalepsis passes the preview URL to Playwright as KATALEPSIS_BASE_URL. It cannot confirm that the Playwright config reads it.",
      );
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("keeps finished tests when Playwright stops part way and lists the rest as not finished", async () => {
    const { layer } = layers({
      run: () =>
        Effect.succeed(
          report([
            { title: "signs up", tests: [test()] },
            {
              title: "rejects a bad email",
              tests: [test({ status: "skipped", results: [result({ status: "interrupted" })] })],
            },
          ]),
        ),
      stoppedBy: new PlaywrightProcessError({
        message: "Playwright did not finish within 60s",
        retryable: true,
        output: "",
      }),
    });

    const outcome = await Effect.runPromise(verifyWithPlaywright(options()).pipe(Effect.provide(layer)));

    expect(outcome.run.status).toBe("blocked");
    expect(outcome.run.checks.map((check) => [check.title, check.status])).toEqual([["signs up", "passed"]]);
    expect(outcome.run.notTested).toEqual([
      expect.objectContaining({
        title: "rejects a bad email",
        reason: "Not finished: the run stopped before this test completed",
      }),
    ]);
    expect(outcome.run.errors.map((error) => error.message)).toEqual([
      expect.stringContaining("Playwright did not finish within 60s"),
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
        installBrowsers: () => Effect.succeed("installed"),
        list: () => failingList,
        run: () => Effect.succeed({ report: report([]), exitCode: 1, output: "", stoppedBy: null }),
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

const CHECKOUT = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const oneTest = (status: "passed" | "failed") => ({
  listed: report([{ title: "signs up", tests: [test({ status: "skipped", results: [] })] }]),
  run: () =>
    Effect.succeed(
      report([
        {
          title: "signs up",
          tests: [
            status === "passed"
              ? test()
              : test({ status: "unexpected", results: [result({ status: "failed", error: { message: "boom" } })] }),
          ],
        },
      ]),
    ),
});
const verify = (
  layer: Layer.Layer<PlaywrightRunner | PreviewProbe | RunMetadata>,
  overrides: Partial<VerifyOptions> = {},
) => Effect.runPromise(verifyWithPlaywright(options(overrides)).pipe(Effect.provide(layer)));

describe("preview commit", () => {
  it("confirms the preview when it reports the checkout HEAD, even as a short SHA", async () => {
    const { layer } = layers(
      oneTest("passed"),
      { reachable: true, commit: { sha: "0123456", source: "header" } },
      CHECKOUT,
    );

    const { run } = await verify(layer);

    expect(run.status).toBe("passed");
    expect(run.commitAlignment).toBe("confirmed");
    expect(run.previewCommit).toEqual({ sha: "0123456", source: "header" });
    expect(run.errors).toEqual([]);
  });

  it("blocks a passing run when the preview was built from another commit", async () => {
    const { layer } = layers(oneTest("passed"), { reachable: true, commit: { sha: OTHER, source: "meta" } }, CHECKOUT);

    const { run } = await verify(layer);

    expect(run.checks.map((check) => check.status)).toEqual(["passed"]);
    expect(run.status).toBe("blocked");
    expect(run.commitAlignment).toBe("mismatched");
    expect(run.errors).toEqual([expect.objectContaining({ category: "commit-mismatch", stage: "preview-commit" })]);
    expect(run.errors[0]?.message).toContain(OTHER);
  });

  it("keeps a failed run failed when the preview was built from another commit", async () => {
    const { layer } = layers(
      oneTest("failed"),
      { reachable: true, commit: { sha: OTHER, source: "header" } },
      CHECKOUT,
    );

    const { run } = await verify(layer);

    expect(run.status).toBe("failed");
    expect(run.commitAlignment).toBe("mismatched");
  });

  it("trusts what the preview reports over the given commit", async () => {
    const { layer } = layers(
      oneTest("passed"),
      { reachable: true, commit: { sha: OTHER, source: "header" } },
      CHECKOUT,
    );

    const { run } = await verify(layer, { previewCommit: CHECKOUT });

    expect(run.previewCommit).toEqual({ sha: OTHER, source: "header" });
    expect(run.commitAlignment).toBe("mismatched");
    expect(run.status).toBe("blocked");
    expect(run.coverageLimitations.join("\n")).toContain(`the commit passed to katalepsis, ${CHECKOUT}, was not used`);
  });

  it("uses the given commit when the preview reports none", async () => {
    const { layer } = layers(oneTest("passed"), { reachable: true, commit: null }, CHECKOUT);

    const { run } = await verify(layer, { previewCommit: CHECKOUT.toUpperCase() });

    expect(run.previewCommit).toEqual({ sha: CHECKOUT, source: "option" });
    expect(run.commitAlignment).toBe("confirmed");
    expect(run.status).toBe("passed");
  });

  it("leaves the verdict alone and says why when the preview reports no commit", async () => {
    const { layer } = layers(oneTest("passed"), { reachable: true, commit: null }, CHECKOUT);

    const { run } = await verify(layer);

    expect(run.status).toBe("passed");
    expect(run.commitAlignment).toBe("unknown");
    expect(run.coverageLimitations.join("\n")).toContain("The preview did not report its commit");
  });

  it("is unknown when the checkout has no commit, even if the preview reports one", async () => {
    const { layer } = layers(oneTest("passed"), { reachable: true, commit: { sha: OTHER, source: "header" } }, null);

    const { run } = await verify(layer);

    expect(run.status).toBe("passed");
    expect(run.commitAlignment).toBe("unknown");
    expect(run.previewCommit?.sha).toBe(OTHER);
  });

  it("refuses a given commit that is not a SHA before writing anything", async () => {
    const { layer } = layers(oneTest("passed"));

    const failure = await Effect.runPromise(
      Effect.flip(verifyWithPlaywright(options({ previewCommit: "main" })).pipe(Effect.provide(layer))),
    );

    expect(failure._tag).toBe("ConfigurationError");
    expect(await readdir(outDir)).toEqual([]);
  });
});
