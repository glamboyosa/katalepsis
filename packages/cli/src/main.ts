#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { authForgetCommand, authSetCommand, authStatusCommand } from "./commands/auth.ts";
import { configModelCommand, configProviderCommand, configShowCommand, modelsCommand } from "./commands/config.ts";
import { initCommand } from "./commands/init.ts";
import { reportOpenCommand } from "./commands/report.ts";
import { defaultOutDir, runCommand } from "./commands/run.ts";
import { verifyCommand } from "./commands/verify.ts";
import { EXIT, UsageError } from "./exit-codes.ts";

const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };

const USAGE = `Usage:
  katalepsis init [--cwd <dir>]
  katalepsis run --url <preview-url> [--cwd <dir>] [--config <file>] [--project <name>]... [--grep <pattern>]
               [--out <dir>] [--timeout <seconds>] [--env <label>] [--install-browsers]
  katalepsis verify --url <preview-url> --checks <checks.json> [--provider <anthropic|openai|openrouter>]
                  [--model <id>] [--allow-origin <url>]... [--max-steps <n>] [--max-tokens <n>] [--check-timeout <seconds>]
                  [--cwd <dir>] [--out <dir>] [--env <label>]
  katalepsis report open [<run-id>] [--cwd <dir>] [--out <dir>] [--print]
  katalepsis auth set <anthropic|openai|openrouter>      Save a key in the OS keychain (read without echo)
  katalepsis auth status                                 Show where each key comes from
  katalepsis auth forget <anthropic|openai|openrouter>   Remove a key from the OS keychain
  katalepsis config provider <anthropic|openai|openrouter>
  katalepsis config model <model-id>
  katalepsis config show
  katalepsis models <anthropic|openai|openrouter>        List model IDs from the provider

Exit codes: 0 passed, 1 failed, 2 blocked, 3 usage or setup error, 4 report could not be written.`;

const DEFAULT_TIMEOUT_SECONDS = 1800;
const DEFAULT_MAX_STEPS = 15;
const DEFAULT_MAX_TOKENS = 200_000;
const DEFAULT_CHECK_TIMEOUT_SECONDS = 120;

const parsePositiveInt = (value: string | undefined, fallback: number, flag: string): number => {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) === 0) throw new UsageError(`${flag} must be a positive whole number`);
  return Number(value);
};

/** Resolves --config against --cwd, like the other project paths, and checks it exists. */
const resolveConfig = (cwd: string, config: string | undefined): string | null => {
  if (config === undefined) return null;
  const resolved = path.resolve(cwd, config);
  if (!existsSync(resolved)) throw new Error(`--config file not found: ${resolved}`);
  return resolved;
};

const main = async (argv: ReadonlyArray<string>): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      url: { type: "string" },
      cwd: { type: "string" },
      config: { type: "string" },
      project: { type: "string", multiple: true },
      grep: { type: "string" },
      out: { type: "string" },
      timeout: { type: "string" },
      env: { type: "string" },
      print: { type: "boolean" },
      "install-browsers": { type: "boolean" },
      checks: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      "allow-origin": { type: "string", multiple: true },
      "max-steps": { type: "string" },
      "max-tokens": { type: "string" },
      "check-timeout": { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.version) {
    console.log(packageJson.version);
    return EXIT.passed;
  }
  const [command, subcommand, ...rest] = positionals;
  if (values.help || command === undefined) {
    console.log(USAGE);
    return values.help ? EXIT.passed : EXIT.usage;
  }
  const cwd = path.resolve(values.cwd ?? process.cwd());
  const out = values.out === undefined ? null : path.resolve(values.out);

  if (command === "init") return initCommand(cwd);
  if (command === "run") {
    if (values.url === undefined) throw new UsageError("run needs --url <preview-url>");
    return runCommand({
      url: values.url,
      cwd,
      out,
      config: resolveConfig(cwd, values.config),
      projects: values.project ?? [],
      grep: values.grep ?? null,
      timeoutSeconds: parsePositiveInt(values.timeout, DEFAULT_TIMEOUT_SECONDS, "--timeout"),
      environment: values.env ?? "local",
      version: packageJson.version,
      installBrowsers: values["install-browsers"] ?? false,
    });
  }
  if (command === "verify") {
    if (values.url === undefined || values.checks === undefined) {
      throw new UsageError("verify needs --url <preview-url> and --checks <checks.json>");
    }
    return verifyCommand({
      url: values.url,
      checksPath: path.resolve(cwd, values.checks),
      cwd,
      out,
      provider: values.provider ?? null,
      model: values.model ?? null,
      allowOrigins: values["allow-origin"] ?? [],
      maxSteps: parsePositiveInt(values["max-steps"], DEFAULT_MAX_STEPS, "--max-steps"),
      maxTokens: parsePositiveInt(values["max-tokens"], DEFAULT_MAX_TOKENS, "--max-tokens"),
      checkTimeoutSeconds: parsePositiveInt(values["check-timeout"], DEFAULT_CHECK_TIMEOUT_SECONDS, "--check-timeout"),
      environment: values.env ?? "local",
      version: packageJson.version,
    });
  }
  if (command === "auth" && subcommand === "set") return authSetCommand(rest[0]);
  if (command === "auth" && (subcommand === "status" || subcommand === undefined)) return authStatusCommand();
  if (command === "auth" && subcommand === "forget") return authForgetCommand(rest[0]);
  if (command === "config" && subcommand === "provider") return configProviderCommand(rest[0]);
  if (command === "config" && subcommand === "model") return configModelCommand(rest[0]);
  if (command === "config" && (subcommand === "show" || subcommand === undefined)) return configShowCommand();
  if (command === "models") return modelsCommand(subcommand);
  if (command === "report" && subcommand === "open") {
    return reportOpenCommand(out ?? defaultOutDir(cwd), rest[0] ?? null, values.print ?? false);
  }
  throw new UsageError(`Unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`);
};

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // node:util parseArgs reports unknown or malformed options with ERR_PARSE_ARGS_* codes.
    const isUsage =
      error instanceof UsageError ||
      (error instanceof Error && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS"));
    console.error(isUsage ? `katalepsis: ${message}\n\n${USAGE}` : `katalepsis: ${message}`);
    process.exitCode = EXIT.usage;
  },
);
