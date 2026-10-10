import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { ReportWriteError } from "./errors.ts";
import { renderHtml } from "./render-html.ts";
import { renderMarkdown } from "./render-markdown.ts";
import type { VerificationRun } from "./schema.ts";

/** Run IDs start with the start time, so sorting them by name sorts them by time. */
export const newRunId = (startedAt: Date): string =>
  `${startedAt.toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;

/** Writes the manifest and both rendered reports for a validated run. */
export const writeBundle = (bundleDir: string, run: VerificationRun): Effect.Effect<void, ReportWriteError> =>
  Effect.tryPromise({
    try: async () => {
      await writeFile(path.join(bundleDir, "manifest.json"), `${JSON.stringify(run, null, 2)}\n`);
      await writeFile(path.join(bundleDir, "report.md"), renderMarkdown(run));
      await writeFile(path.join(bundleDir, "report.html"), renderHtml(run));
    },
    catch: (cause) => new ReportWriteError({ message: `Could not write the report: ${String(cause)}` }),
  });
