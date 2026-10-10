import path from "node:path";
import { Effect, Layer } from "effect";
import { PlaywrightRunnerLive, PreviewProbeLive, RunMetadataLive, verifyWithPlaywright } from "@katalepsis/core";
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
};

const LiveLayer = Layer.mergeAll(PlaywrightRunnerLive, PreviewProbeLive, RunMetadataLive);

export const defaultOutDir = (cwd: string): string => path.join(cwd, "artifacts", "katalepsis");

/** Runs verification, prints a short summary and returns the process exit code. */
export const runCommand = (args: RunArgs): Promise<number> => {
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
