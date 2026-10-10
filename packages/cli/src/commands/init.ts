import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { CONFIG_NAMES, PlaywrightRunner, PlaywrightRunnerLive } from "@katalepsis/core";
import { EXIT } from "../exit-codes.ts";

const IGNORE_ENTRY = "artifacts/katalepsis/";

const CONFIG_SNIPPET = `use: {
  baseURL: process.env.KATALEPSIS_BASE_URL ?? "http://localhost:3000",
  screenshot: "only-on-failure",
  video: "retain-on-failure",
  trace: "retain-on-failure",
},`;

const ensureGitignore = async (cwd: string): Promise<string> => {
  const file = path.join(cwd, ".gitignore");
  const contents = existsSync(file) ? await readFile(file, "utf8") : "";
  const lines = contents.split(/\r?\n/).map((line) => line.trim());
  if (lines.some((line) => line === IGNORE_ENTRY || line === "artifacts/" || line === "artifacts")) {
    return "Reports are already ignored by git.";
  }
  const prefix = contents === "" || contents.endsWith("\n") ? "" : "\n";
  await appendFile(file, `${prefix}${IGNORE_ENTRY}\n`);
  return `Added ${IGNORE_ENTRY} to .gitignore.`;
};

/**
 * Checks that a project can be verified and adds the report folder to .gitignore.
 * Config checks read the file as text, so they are hints rather than proof.
 */
export const initCommand = async (cwd: string): Promise<number> => {
  const located = await Effect.runPromise(
    Effect.gen(function* () {
      const runner = yield* PlaywrightRunner;
      return yield* runner.locate(cwd);
    }).pipe(Effect.result, Effect.provide(PlaywrightRunnerLive)),
  );
  if (located._tag === "Failure") {
    console.error(`katalepsis: ${located.failure.message}`);
    return EXIT.usage;
  }
  console.log(`Found @playwright/test ${located.success.version}.`);

  const configName = CONFIG_NAMES.find((name) => existsSync(path.join(cwd, name)));
  if (configName === undefined) {
    console.error(
      "katalepsis: no playwright.config file found. Pass --config to `katalepsis run` if it lives elsewhere.",
    );
    return EXIT.usage;
  }
  const configText = await readFile(path.join(cwd, configName), "utf8");
  console.log(`Found ${configName}.`);

  const missing = ["KATALEPSIS_BASE_URL", "screenshot", "video", "trace"].filter((term) => !configText.includes(term));
  if (missing.length > 0) {
    console.log(`\n${configName} does not mention: ${missing.join(", ")}.`);
    console.log("katalepsis passes the preview URL as KATALEPSIS_BASE_URL. Add or merge this into the config:\n");
    console.log(CONFIG_SNIPPET);
  }

  console.log(`\n${await ensureGitignore(cwd)}`);
  console.log("Next: katalepsis run --url <preview-url>");
  return EXIT.passed;
};
