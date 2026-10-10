import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { EXIT } from "../exit-codes.ts";

/** Run IDs start with an ISO timestamp, so the last one in sort order is the newest. */
const latestBundle = async (outDir: string): Promise<string | null> => {
  if (!existsSync(outDir)) return null;
  const entries = await readdir(outDir, { withFileTypes: true });
  const runs = entries
    .filter((entry) => entry.isDirectory() && existsSync(path.join(outDir, entry.name, "report.html")))
    .map((entry) => entry.name)
    .toSorted();
  const latest = runs.at(-1);
  return latest === undefined ? null : path.join(outDir, latest);
};

const openerFor = (platform: NodeJS.Platform): { command: string; args: Array<string> } => {
  if (platform === "darwin") return { command: "open", args: [] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", ""] };
  return { command: "xdg-open", args: [] };
};

/** Prints the path of a report and opens it in the default browser unless `printOnly` is set. */
export const reportOpenCommand = async (outDir: string, runId: string | null, printOnly: boolean): Promise<number> => {
  const bundleDir = runId === null ? await latestBundle(outDir) : path.join(outDir, path.basename(runId));
  const reportPath = bundleDir === null ? null : path.join(bundleDir, "report.html");
  if (reportPath === null || !existsSync(reportPath)) {
    console.error(`katalepsis: no report found in ${outDir}. Run \`katalepsis run --url <preview-url>\` first.`);
    return EXIT.usage;
  }
  console.log(reportPath);
  if (!printOnly) {
    const opener = openerFor(process.platform);
    spawn(opener.command, [...opener.args, reportPath], { stdio: "ignore", detached: true }).unref();
  }
  return EXIT.passed;
};
