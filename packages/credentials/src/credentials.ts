import { Effect, Redacted } from "effect";
import { Keychain, type KeychainError } from "./keychain.ts";
import { ENV_VAR, type Provider } from "./providers.ts";

export type CredentialSource = "environment" | "keychain" | "missing";

export type ResolvedCredential = {
  readonly provider: Provider;
  readonly source: CredentialSource;
  /** Null when missing. Redacted so it never prints in logs, errors or JSON. */
  readonly key: Redacted.Redacted<string> | null;
};

export type Environment = Readonly<Record<string, string | undefined>>;

/** CI must use its secret store only, never a developer's keychain. */
export const isCi = (env: Environment): boolean => env["CI"] !== undefined && env["CI"] !== "" && env["CI"] !== "false";

/**
 * Resolves a provider key: a non-empty environment variable wins, then the OS keychain,
 * except in CI. This follows Docket's order (see docs/reference-review.md).
 */
export const resolveCredential = (
  provider: Provider,
  env: Environment,
): Effect.Effect<ResolvedCredential, KeychainError, Keychain> =>
  Effect.gen(function* () {
    const fromEnv = env[ENV_VAR[provider]]?.trim();
    if (fromEnv) return { provider, source: "environment", key: Redacted.make(fromEnv) };
    if (isCi(env)) return { provider, source: "missing", key: null };
    const keychain = yield* Keychain;
    const stored = (yield* keychain.get(provider))?.trim();
    return stored
      ? { provider, source: "keychain", key: Redacted.make(stored) }
      : { provider, source: "missing", key: null };
  });
