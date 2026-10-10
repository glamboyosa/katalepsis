import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";

// Only a browser that was never downloaded. Missing system libraries need install-deps instead.
const MISSING_BROWSER = /Executable doesn't exist|Looks like Playwright was just installed or updated/;
const INSTALL_TIMEOUT_MS = 15 * 60_000;

/** Set this to stop katalepsis downloading Chromium for agent checks. */
export const NO_DOWNLOAD_ENV = "KATALEPSIS_NO_BROWSER_DOWNLOAD";

const installHeadlessShell = (signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    const packageDir = path.dirname(createRequire(import.meta.url).resolve("playwright-core/package.json"));
    // stdout is reserved for the MCP protocol when this runs inside the MCP server.
    const child = spawn(process.execPath, [path.join(packageDir, "cli.js"), "install", "chromium-headless-shell"], {
      stdio: ["ignore", "pipe", "pipe"],
      // A cancelled run or a closing MCP client stops the download instead of waiting for it.
      ...(signal === undefined ? {} : { signal }),
    });
    child.stdout.pipe(process.stderr);
    child.stderr.pipe(process.stderr);
    const timer = setTimeout(() => child.kill("SIGTERM"), INSTALL_TIMEOUT_MS);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Installing Chromium for agent checks failed (exit code ${code ?? "unknown"}).`));
    });
  });

/**
 * Launches the Chromium that agent checks use. If it has never been downloaded, downloads
 * it once into Playwright's shared browser cache and tries again, unless
 * KATALEPSIS_NO_BROWSER_DOWNLOAD is set.
 */
export const launchAgentBrowser = async (
  env: Readonly<Record<string, string | undefined>> = process.env,
  signal?: AbortSignal,
): Promise<Browser> => {
  try {
    return await chromium.launch();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!MISSING_BROWSER.test(message)) throw error;
    if (env[NO_DOWNLOAD_ENV]) {
      throw new Error(`Chromium for agent checks is not installed, and ${NO_DOWNLOAD_ENV} is set.`, { cause: error });
    }
    console.error(
      "katalepsis: downloading Chromium for agent checks. This happens once and uses about 200 MB of disk.",
    );
    await installHeadlessShell(signal);
    return chromium.launch();
  }
};
