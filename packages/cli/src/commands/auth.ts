import {
  ENV_VAR,
  isProvider,
  Keychain,
  KeychainLive,
  PROVIDERS,
  resolveCredential,
  type Provider,
} from "@katalepsis/credentials";
import { Effect } from "effect";
import { EXIT } from "../exit-codes.ts";
import { readSecret } from "./secret-input.ts";

const parseProvider = (value: string | undefined): Provider => {
  if (value === undefined || !isProvider(value)) throw new Error(`Name a provider: ${PROVIDERS.join(" or ")}.`);
  return value;
};

const runKeychain = <A>(effect: Effect.Effect<A, { readonly message: string }, Keychain>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(KeychainLive),
      Effect.mapError((error) => new Error(error.message)),
    ),
  );

/** Saves a key in the OS keychain only. The key is read without echo and never printed. */
export const authSetCommand = async (providerName: string | undefined): Promise<number> => {
  const provider = parseProvider(providerName);
  const key = await readSecret(`${provider} API key: `);
  if (key === "") throw new Error("No key entered.");
  await runKeychain(
    Effect.gen(function* () {
      const keychain = yield* Keychain;
      yield* keychain.set(provider, key);
    }),
  );
  console.log(`Saved the ${provider} key to the OS keychain.`);
  if (process.env[ENV_VAR[provider]])
    console.log(`Note: ${ENV_VAR[provider]} is set and takes precedence over the keychain.`);
  return EXIT.passed;
};

/** Prints where each provider's key would come from. Never prints any part of a key. */
export const authStatusCommand = async (): Promise<number> => {
  for (const provider of PROVIDERS) {
    const credential = await runKeychain(resolveCredential(provider, process.env));
    const source = credential.source === "environment" ? `environment (${ENV_VAR[provider]})` : credential.source;
    console.log(`${provider.padEnd(12)} ${source}`);
  }
  return EXIT.passed;
};

export const authForgetCommand = async (providerName: string | undefined): Promise<number> => {
  const provider = parseProvider(providerName);
  const removed = await runKeychain(
    Effect.gen(function* () {
      const keychain = yield* Keychain;
      return yield* keychain.remove(provider);
    }),
  );
  console.log(
    removed ? `Removed the ${provider} key from the OS keychain.` : `No ${provider} key was stored in the OS keychain.`,
  );
  return EXIT.passed;
};
