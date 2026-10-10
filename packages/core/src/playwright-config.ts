import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const CONFIG_NAMES = ["ts", "js", "mts", "mjs", "cts", "cjs"].map(
  (extension) => `playwright.config.${extension}`,
);

/** Finds the config Playwright loads: the --config file, else playwright.config.* in cwd. */
export const findPlaywrightConfig = (cwd: string, config: string | null): string | null => {
  if (config !== null) return path.resolve(cwd, config);
  const name = CONFIG_NAMES.find((candidate) => existsSync(path.join(cwd, candidate)));
  return name === undefined ? null : path.join(cwd, name);
};

/**
 * Whether the config text mentions KATALEPSIS_BASE_URL. Playwright does not report the
 * resolved baseURL, so this text check is the only hint katalepsis has that tests will
 * use the preview URL. Returns null when there is no readable config.
 */
export const configMentionsBaseUrl = async (file: string | null): Promise<boolean | null> => {
  if (file === null) return null;
  const text = await readFile(file, "utf8").catch(() => null);
  return text === null ? null : text.includes("KATALEPSIS_BASE_URL");
};
