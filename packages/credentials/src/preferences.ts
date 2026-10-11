import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Data, Effect, Schema } from "effect";
import { Provider } from "./providers.ts";
import type { Environment } from "./credentials.ts";

/** Non-secret preferences. There is deliberately no field that could hold a key. */
export const Preferences = Schema.Struct({
  provider: Schema.optional(Provider),
  model: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
});
export type Preferences = typeof Preferences.Type;

export class PreferencesError extends Data.TaggedError("PreferencesError")<{ readonly message: string }> {}

/** Reads an environment variable, treating an empty value as unset. */
const setting = (env: Environment, name: string): string | null => {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? null : value;
};

/** `$KATALEPSIS_HOME`, else `$XDG_CONFIG_HOME/katalepsis`, else `~/.config/katalepsis`. */
export const configDir = (env: Environment): string =>
  setting(env, "KATALEPSIS_HOME") ??
  path.join(setting(env, "XDG_CONFIG_HOME") ?? path.join(os.homedir(), ".config"), "katalepsis");

const configFile = (env: Environment): string => path.join(configDir(env), "config.json");

export const loadPreferences = (env: Environment): Effect.Effect<Preferences, PreferencesError> =>
  Effect.tryPromise({
    try: async () => {
      const text = await readFile(configFile(env), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "{}";
        throw error;
      });
      return JSON.parse(text) as unknown;
    },
    catch: (cause) => new PreferencesError({ message: `Could not read ${configFile(env)}: ${String(cause)}` }),
  }).pipe(
    Effect.flatMap((raw) =>
      Schema.decodeUnknownEffect(Preferences)(raw).pipe(
        Effect.mapError(
          (error) => new PreferencesError({ message: `${configFile(env)} is not valid: ${error.message}` }),
        ),
      ),
    ),
  );

/** Saves preferences readable only by the current user: directory 0700, file 0600. */
export const savePreferences = (env: Environment, preferences: Preferences): Effect.Effect<string, PreferencesError> =>
  Effect.tryPromise({
    try: async () => {
      const dir = configDir(env);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      const file = configFile(env);
      await writeFile(file, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600 });
      await chmod(file, 0o600);
      return file;
    },
    catch: (cause) => new PreferencesError({ message: `Could not write ${configFile(env)}: ${String(cause)}` }),
  });

export type ModelChoice = { readonly provider: Provider; readonly model: string };

/**
 * Picks the provider and model: command-line flags, then KATALEPSIS_PROVIDER and
 * KATALEPSIS_MODEL, then saved preferences. There is no built-in default model.
 */
export const resolveModelChoice = (
  preferences: Preferences,
  env: Environment,
  flags: { readonly provider: string | null; readonly model: string | null },
): ModelChoice | { readonly missing: string } => {
  const providerInput = flags.provider ?? setting(env, "KATALEPSIS_PROVIDER") ?? preferences.provider ?? null;
  const model = flags.model ?? setting(env, "KATALEPSIS_MODEL") ?? preferences.model ?? null;
  if (providerInput === null)
    return { missing: "No provider chosen. Run `katalepsis config provider <anthropic|openai|openrouter>`." };
  if (!Schema.is(Provider)(providerInput))
    return { missing: `Unknown provider "${providerInput}". Use anthropic, openai or openrouter.` };
  if (model === null || model.trim() === "")
    return { missing: "No model chosen. Run `katalepsis config model <model-id>`." };
  return { provider: providerInput, model: model.trim() };
};
