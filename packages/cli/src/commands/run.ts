import path from "node:path";
import { Effect, Layer } from "effect";
import {
  configMentionsBaseUrl,
  findPlaywrightConfig,
  PlaywrightRunnerLive,
  PreviewProbeLive,
  RunMetadataLive,
  verifyWithPlaywright,
} from "@katalepsis/core";
import { EXIT, exitCodeFor } from "../exit-codes.ts";
import { cancelOnSignal } from "./cancel.ts";

export type RunArgs = {
  readonly url: string;
  readonly cwd: string;
  readonly out: string | null;
  readonly config: string | null;
  readonly projects: ReadonlyArray<string>;
  readonly grep: string | null;
  readonly timeoutSeconds: number;
  readonly environment: string;
  readonly version: string;
  /** Run the project's own `playwright install` first. */
  readonly installBrowsers: boolean;
};

const LiveLayer = Layer.mergeAll(PlaywrightRunnerLive, PreviewProbeLive, RunMetadataLive);

export const defaultOutDir = (cwd: string): string => path.join(cwd, "artifacts", "katalepsis");

/** Runs verification, prints a short summary and returns the process exit code. */
export const runCommand = async (args: RunArgs): Promise<number> => {
  const configFile = findPlaywrightConfig(args.cwd, args.config);
  if (configFile !== null && (await configMentionsBaseUrl(configFile)) === false) {
    console.error(
      `katalepsis: warning: ${path.basename(configFile)} does not read KATALEPSIS_BASE_URL, so the tests will probably run against the baseURL in that config, not the preview URL. \`katalepsis init\` prints the setting to add.`,
    );
  }
  const cancellation = cancelOnSignal();
  return verifyWithPlaywright({
    previewUrl: args.url,
    cwd: args.cwd,
    outDir: args.out ?? defaultOutDir(args.cwd),
    config: args.config,
    projects: args.projects,
    grep: args.grep,
    timeoutMs: args.timeoutSeconds * 1000,
    environment: args.environment,
    toolVersion: args.version,
    installBrowsers: args.installBrowsers,
    signal: cancellation.signal,
  })
    .pipe(
      Effect.map(({ run, bundleDir }) => {
        const count = (status: string) => run.checks.filter((check) => check.status === status).length;
        console.log(`katalepsis: ${run.status.toUpperCase()}`);
        console.log(
          `  ${count("passed")} passed, ${count("failed")} failed, ${count("blocked")} blocked, ${run.notTested.length} not tested`,
        );
        for (const error of run.errors) console.log(`  ${error.category}: ${error.message}`);
        console.log(`  Report: ${path.join(bundleDir, "report.html")}`);
        console.log(`  Markdown: ${path.join(bundleDir, "report.md")}`);
        if (run.checks.some((check) => check.failure?.code === "browser")) {
          console.log(
            "  A browser could not start. Run again with --install-browsers to install what Playwright needs.",
          );
        }
        return exitCodeFor(run.status);
      }),
      Effect.catchTags({
        ConfigurationError: (error) =>
          Effect.sync(() => {
            console.error(`katalepsis: ${error.message}`);
            return EXIT.usage;
          }),
        ReportWriteError: (error) =>
          Effect.sync(() => {
            console.error(`katalepsis: ${error.message}`);
            return EXIT.reportWrite;
          }),
      }),
      Effect.provide(LiveLayer),
      Effect.runPromise,
    )
    .finally(cancellation.dispose);
};
