import type { RunError } from "@katalepsis/core";
import {
  ENV_VAR,
  isCi,
  KeychainLive,
  loadPreferences,
  resolveCredential,
  resolveModelChoice,
  type Environment,
} from "@katalepsis/credentials";
import { Effect, Redacted } from "effect";
import { createModel, validateModel } from "./models.ts";
import type { ModelSetup } from "./verify-agent.ts";

const setupError = (category: RunError["category"], message: string): ModelSetup => ({
  error: { category, message, stage: "model-setup", retryable: false },
});

/**
 * Picks the provider and model from flags, environment and saved preferences, finds the
 * key (environment, then keychain) and checks the model exists, all before any check runs.
 * The CLI and the MCP server share this, so neither ever takes a key as an argument.
 */
export const setupLocalModel = async (
  env: Environment,
  flags: { readonly provider: string | null; readonly model: string | null },
): Promise<ModelSetup> => {
  const preferences = await Effect.runPromise(Effect.result(loadPreferences(env)));
  if (preferences._tag === "Failure") return setupError("configuration", preferences.failure.message);
  const choice = resolveModelChoice(preferences.success, env, flags);
  if ("missing" in choice) return setupError("configuration", choice.missing);

  const credential = await Effect.runPromise(
    Effect.result(resolveCredential(choice.provider, env).pipe(Effect.provide(KeychainLive))),
  );
  if (credential._tag === "Failure") return setupError("credentials", credential.failure.message);
  const key = credential.success.key;
  if (key === null) {
    const hint = isCi(env)
      ? `Set the ${ENV_VAR[choice.provider]} secret for this job.`
      : `Run \`katalepsis auth set ${choice.provider}\` or set ${ENV_VAR[choice.provider]}.`;
    return setupError("credentials", `No ${choice.provider} API key. ${hint}`);
  }
  const validation = await validateModel(choice, key);
  if (!validation.ok) return setupError(validation.kind, validation.message);
  return {
    model: createModel(choice, key),
    info: { provider: choice.provider, id: choice.model },
    secrets: [Redacted.value(key)],
  };
};
