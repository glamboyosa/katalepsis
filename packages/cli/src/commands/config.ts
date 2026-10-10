import {
  isProvider,
  KeychainLive,
  loadPreferences,
  PROVIDERS,
  resolveCredential,
  savePreferences,
  type Preferences,
} from "@katalepsis/credentials";
import { listModels, validateModel } from "@katalepsis/agent";
import { Effect } from "effect";
import { EXIT, UsageError } from "../exit-codes.ts";

const run = <A>(effect: Effect.Effect<A, { readonly message: string }>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.mapError((error) => new Error(error.message))));

const update = async (change: Partial<Preferences>): Promise<string> => {
  const current = await run(loadPreferences(process.env));
  return run(savePreferences(process.env, { ...current, ...change }));
};

export const configProviderCommand = async (value: string | undefined): Promise<number> => {
  if (value === undefined || !isProvider(value)) throw new UsageError(`Name a provider: ${PROVIDERS.join(" or ")}.`);
  const current = await run(loadPreferences(process.env));
  // Model IDs differ between providers, so a model saved for another provider is dropped.
  const keepModel = current.provider === value || current.provider === undefined;
  const { model, ...rest } = current;
  const next = keepModel ? { ...current, provider: value } : { ...rest, provider: value };
  const file = await run(savePreferences(process.env, next));
  console.log(`Provider set to ${value} in ${file}.`);
  if (!keepModel && model !== undefined) {
    console.log(
      `Cleared the ${current.provider} model ${model}. Choose one with \`katalepsis config model <model-id>\`.`,
    );
  }
  return EXIT.passed;
};

/**
 * Saves the model after checking it exists in the provider's catalog. Without a key the
 * check is skipped and happens again at the start of every verify run.
 */
export const configModelCommand = async (value: string | undefined): Promise<number> => {
  if (value === undefined || value.trim() === "")
    throw new UsageError("Name a model, for example from `katalepsis models <provider>`.");
  const preferences = await run(loadPreferences(process.env));
  const provider = preferences.provider;
  if (provider === undefined)
    throw new Error("Choose a provider first: `katalepsis config provider <openai|openrouter>`.");
  const credential = await run(resolveCredential(provider, process.env).pipe(Effect.provide(KeychainLive)));
  if (credential.key === null) {
    console.log(
      `No ${provider} key, so the model was not checked against the catalog. verify checks it before running.`,
    );
  } else {
    const validation = await validateModel({ provider, model: value.trim() }, credential.key);
    if (!validation.ok) {
      console.error(`katalepsis: ${validation.message}`);
      return EXIT.usage;
    }
  }
  const file = await update({ model: value.trim() });
  console.log(`Model set to ${value.trim()} in ${file}.`);
  return EXIT.passed;
};

export const configShowCommand = async (): Promise<number> => {
  const preferences = await run(loadPreferences(process.env));
  console.log(`provider  ${preferences.provider ?? "not set"}`);
  console.log(`model     ${preferences.model ?? "not set"}`);
  return EXIT.passed;
};

/** Lists the provider's models, using the key when the catalog needs one. */
export const modelsCommand = async (value: string | undefined): Promise<number> => {
  if (value === undefined || !isProvider(value)) throw new UsageError(`Name a provider: ${PROVIDERS.join(" or ")}.`);
  const credential = await run(resolveCredential(value, process.env).pipe(Effect.provide(KeychainLive)));
  if (value === "openai" && credential.key === null)
    throw new Error("Listing OpenAI models needs a key: `katalepsis auth set openai`.");
  for (const id of await listModels(value, credential.key)) console.log(id);
  return EXIT.passed;
};
