import { AsyncEntry } from "@napi-rs/keyring";
import { Context, Data, Effect, Layer } from "effect";
import type { Provider } from "./providers.ts";

export class KeychainError extends Data.TaggedError("KeychainError")<{ readonly message: string }> {}

/** The OS keychain, one entry per provider under the `katalepsis` service. */
export class Keychain extends Context.Service<
  Keychain,
  {
    readonly get: (provider: Provider) => Effect.Effect<string | null, KeychainError>;
    readonly set: (provider: Provider, key: string) => Effect.Effect<void, KeychainError>;
    /** Returns true when an entry was removed. */
    readonly remove: (provider: Provider) => Effect.Effect<boolean, KeychainError>;
  }
>()("katalepsis/Keychain") {}

const SERVICE = "katalepsis";

// Error text from the platform store never contains the secret, but it is not shown verbatim
// either, because some stores echo the account name and that is enough to identify the entry.
const keychainError = (action: string) => () =>
  new KeychainError({ message: `Could not ${action} the OS keychain entry. Is the keychain unlocked?` });

export const KeychainLive = Layer.succeed(Keychain, {
  get: (provider) =>
    Effect.tryPromise({
      try: async () => (await new AsyncEntry(SERVICE, provider).getPassword()) ?? null,
      catch: keychainError("read"),
    }),
  set: (provider, key) =>
    Effect.tryPromise({
      try: () => new AsyncEntry(SERVICE, provider).setPassword(key),
      catch: keychainError("write"),
    }),
  remove: (provider) =>
    Effect.tryPromise({
      try: () => new AsyncEntry(SERVICE, provider).deleteCredential(),
      catch: keychainError("delete"),
    }),
});
