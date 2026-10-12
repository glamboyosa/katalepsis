import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseChecksFile, setupLocalModel, verifyWithAgent } from "@katalepsis/agent";
import { alignmentSummary, PreviewProbeLive, RunMetadataLive } from "@katalepsis/core";
import { Effect, Layer } from "effect";
import { EXIT, exitCodeFor } from "../exit-codes.ts";
import { cancelOnSignal } from "./cancel.ts";
import { defaultOutDir } from "./run.ts";

export type VerifyArgs = {
  readonly url: string;
  readonly checksPath: string;
  readonly cwd: string;
  readonly out: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly allowOrigins: ReadonlyArray<string>;
  readonly maxSteps: number;
  readonly maxTokens: number;
  readonly checkTimeoutSeconds: number;
  readonly environment: string;
  readonly version: string;
  /** The commit the preview was built from, when CI knows it. */
  readonly previewCommit: string | null;
};

/** Runs agent checks from a checks file and prints the same summary as `run`. */
export const verifyCommand = async (args: VerifyArgs): Promise<number> => {
  const checks = parseChecksFile(await readFile(args.checksPath, "utf8"));
  const cancellation = cancelOnSignal();
  return verifyWithAgent({
    previewUrl: args.url,
    checks,
    checksFile: path.basename(args.checksPath),
    cwd: args.cwd,
    outDir: args.out ?? defaultOutDir(args.cwd),
    extraOrigins: args.allowOrigins,
    budget: { maxSteps: args.maxSteps, maxTotalTokens: args.maxTokens, timeoutMs: args.checkTimeoutSeconds * 1000 },
    environment: args.environment,
    toolVersion: args.version,
    previewCommit: args.previewCommit,
    signal: cancellation.signal,
    setupModel: () => setupLocalModel(process.env, { provider: args.provider, model: args.model }),
  })
    .pipe(
      Effect.map(({ run, bundleDir }) => {
        const count = (status: string) => run.checks.filter((check) => check.status === status).length;
        console.log(
          `katalepsis: ${run.status.toUpperCase()}${run.model === null ? "" : ` (${run.model.provider}/${run.model.id})`}`,
        );
        console.log(`  ${count("passed")} passed, ${count("failed")} failed, ${count("blocked")} blocked`);
        console.log(`  Preview commit: ${alignmentSummary(run)}`);
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
      Effect.provide(Layer.merge(PreviewProbeLive, RunMetadataLive)),
      Effect.runPromise,
    )
    .finally(cancellation.dispose);
};
