import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { ConfigurationError, PlaywrightProcessError, ReporterOutputError } from "./errors.ts";
import { PlaywrightJsonReport } from "./playwright-report.ts";

export type PlaywrightInstall = { readonly cliPath: string; readonly version: string };

export type PlaywrightSelection = {
  readonly cwd: string;
  readonly install: PlaywrightInstall;
  readonly config: string | null;
  readonly projects: ReadonlyArray<string>;
  readonly grep: string | null;
  /**
   * The unredacted preview URL, passed as KATALEPSIS_BASE_URL to both listing and running,
   * so a config that reads it declares the same tests in both.
   */
  readonly baseUrl: string;
  /** Aborting it stops Playwright and its browsers. */
  readonly signal: AbortSignal;
};

export type PlaywrightRunOptions = PlaywrightSelection & {
  readonly outputDir: string;
  readonly jsonFile: string;
  readonly timeoutMs: number;
};

export type PlaywrightRunResult = {
  readonly report: PlaywrightJsonReport;
  readonly exitCode: number | null;
  /** Combined stdout and stderr, truncated to the last 256 KiB. */
  readonly output: string;
};

export class PlaywrightRunner extends Context.Service<
  PlaywrightRunner,
  {
    readonly locate: (cwd: string) => Effect.Effect<PlaywrightInstall, ConfigurationError>;
    readonly list: (
      selection: PlaywrightSelection & { readonly jsonFile: string },
    ) => Effect.Effect<PlaywrightJsonReport, PlaywrightProcessError | ReporterOutputError>;
    readonly run: (
      options: PlaywrightRunOptions,
    ) => Effect.Effect<PlaywrightRunResult, PlaywrightProcessError | ReporterOutputError>;
    /**
     * Runs the project's own `playwright install`, so the browsers match the Playwright
     * version its tests use. Returns the installer's output.
     */
    readonly installBrowsers: (
      cwd: string,
      install: PlaywrightInstall,
      signal: AbortSignal,
    ) => Effect.Effect<string, PlaywrightProcessError>;
  }
>()("katalepsis/PlaywrightRunner") {}

const MAX_OUTPUT_BYTES = 256 * 1024;
const LIST_TIMEOUT_MS = 120_000;

/** Finds the project's own @playwright/test install, so its version and config rules apply. */
const locate = (cwd: string): Effect.Effect<PlaywrightInstall, ConfigurationError> =>
  Effect.try({
    try: () => {
      const require = createRequire(path.join(path.resolve(cwd), "package.json"));
      const packageJson: unknown = require("@playwright/test/package.json");
      const version =
        typeof packageJson === "object" &&
        packageJson !== null &&
        "version" in packageJson &&
        typeof packageJson.version === "string"
          ? packageJson.version
          : "unknown";
      return { cliPath: require.resolve("@playwright/test/cli"), version };
    },
    catch: () =>
      new ConfigurationError({
        message: `@playwright/test is not installed in ${cwd}. Install it in the project under test first.`,
      }),
  });

const selectionArgs = (selection: PlaywrightSelection): Array<string> => [
  ...(selection.config === null ? [] : ["--config", selection.config]),
  ...selection.projects.flatMap((project) => ["--project", project]),
  ...(selection.grep === null ? [] : ["--grep", selection.grep]),
];

type ProcessResult = { readonly exitCode: number | null; readonly output: string };

const KILL_GRACE_MS = 5_000;

// On POSIX, Playwright runs as the leader of its own process group, which also holds its test
// workers. Browsers and ffmpeg run in groups of their own: Playwright closes them on SIGTERM,
// and on SIGKILL they exit when their pipes to Playwright close. Windows has no process groups.
const USE_PROCESS_GROUP = process.platform !== "win32";

// Process groups still running, so the CLI can kill them if the user insists on quitting at once.
const liveGroups = new Set<ChildProcess>();

/** Kills every Playwright process group this process started. For an immediate exit only. */
export const forceStopPlaywright = (): void => {
  for (const child of liveGroups) signalTree(child, "SIGKILL");
};

const signalTree = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (USE_PROCESS_GROUP && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // ESRCH: every process in the group has already exited.
    }
    return;
  }
  child.kill(signal);
};

/**
 * Sends SIGTERM to Playwright's process tree, escalates to SIGKILL after a grace period,
 * waits for Playwright to exit, then kills anything it left behind.
 */
const terminate = (child: ChildProcess): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      signalTree(child, "SIGKILL");
      resume(Effect.void);
      return;
    }
    const escalate = setTimeout(() => signalTree(child, "SIGKILL"), KILL_GRACE_MS);
    child.once("close", () => {
      clearTimeout(escalate);
      signalTree(child, "SIGKILL");
      resume(Effect.void);
    });
    signalTree(child, "SIGTERM");
  });

/** Fails as soon as `signal` aborts. Racing against it interrupts the Playwright process. */
const cancelledBy = <E>(signal: AbortSignal, error: () => E): Effect.Effect<never, E> =>
  Effect.callback<never, E>((resume) => {
    const onAbort = () => resume(Effect.fail(error()));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

const runProcess = (
  args: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal,
): Effect.Effect<ProcessResult, PlaywrightProcessError> =>
  Effect.suspend(() => {
    // Shared with the timeout and cancel paths so their errors keep Playwright's output.
    const log = { output: "" };
    const processError = (message: string, retryable: boolean) =>
      new PlaywrightProcessError({ message, retryable, output: log.output });

    const collect = (chunk: Buffer) => {
      log.output = (log.output + chunk.toString("utf8")).slice(-MAX_OUTPUT_BYTES);
    };

    const exited = Effect.callback<number | null, PlaywrightProcessError>((resume) => {
      const child = spawn(process.execPath, [...args], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: USE_PROCESS_GROUP,
      });
      liveGroups.add(child);
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("error", (error) =>
        resume(Effect.fail(processError(`Could not start Playwright: ${error.message}`, false))),
      );
      child.on("close", (exitCode) => {
        liveGroups.delete(child);
        resume(Effect.succeed(exitCode));
      });
      // Runs when the run is interrupted, timed out or cancelled, so no Playwright process outlives it.
      return terminate(child);
    });

    return exited.pipe(
      Effect.raceFirst(
        cancelledBy(signal, () => processError("The run was cancelled before Playwright finished.", true)),
      ),
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(processError(`Playwright did not finish within ${Math.round(timeoutMs / 1000)}s`, true)),
      }),
      Effect.map((exitCode) => ({ exitCode, output: log.output })),
    );
  });

const readJsonReport = (jsonFile: string, output: string): Effect.Effect<PlaywrightJsonReport, ReporterOutputError> =>
  Effect.tryPromise({
    try: async () => JSON.parse(await readFile(jsonFile, "utf8")) as unknown,
    catch: () => new ReporterOutputError({ message: "Playwright did not write a JSON report.", output }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PlaywrightJsonReport)),
    Effect.mapError((error) =>
      error._tag === "ReporterOutputError"
        ? error
        : new ReporterOutputError({
            message: `Playwright's JSON report has an unexpected shape: ${error.message}`,
            output,
          }),
    ),
  );

const baseEnv = (jsonFile: string): NodeJS.ProcessEnv => ({
  ...process.env,
  PLAYWRIGHT_JSON_OUTPUT_FILE: jsonFile,
  FORCE_COLOR: "0",
});

const INSTALL_TIMEOUT_MS = 15 * 60_000;

export const PlaywrightRunnerLive = Layer.succeed(PlaywrightRunner, {
  locate,
  installBrowsers: (cwd, install, signal) =>
    runProcess(
      [install.cliPath, "install"],
      cwd,
      { ...process.env, FORCE_COLOR: "0" },
      INSTALL_TIMEOUT_MS,
      signal,
    ).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result.output)
          : Effect.fail(
              new PlaywrightProcessError({
                message: `playwright install exited with code ${result.exitCode ?? "unknown"}.`,
                retryable: true,
                output: result.output,
              }),
            ),
      ),
    ),
  list: (selection) =>
    runProcess(
      [selection.install.cliPath, "test", "--list", "--reporter=json", ...selectionArgs(selection)],
      selection.cwd,
      { ...baseEnv(selection.jsonFile), KATALEPSIS_BASE_URL: selection.baseUrl },
      LIST_TIMEOUT_MS,
      selection.signal,
    ).pipe(Effect.flatMap((result) => readJsonReport(selection.jsonFile, result.output))),
  run: (options) =>
    runProcess(
      [options.install.cliPath, "test", "--reporter=json", "--output", options.outputDir, ...selectionArgs(options)],
      options.cwd,
      { ...baseEnv(options.jsonFile), KATALEPSIS_BASE_URL: options.baseUrl },
      options.timeoutMs,
      options.signal,
    ).pipe(
      Effect.flatMap((result) =>
        readJsonReport(options.jsonFile, result.output).pipe(
          Effect.map((report) => ({ report, exitCode: result.exitCode, output: result.output })),
        ),
      ),
    ),
});
