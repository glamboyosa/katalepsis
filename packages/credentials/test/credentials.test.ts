import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Layer, Redacted } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Keychain,
  loadPreferences,
  resolveCredential,
  resolveModelChoice,
  savePreferences,
  type Provider,
} from "../src/index.ts";

const fakeKeychain = (stored: Partial<Record<Provider, string>>) => {
  const reads: Array<Provider> = [];
  const layer = Layer.succeed(Keychain, {
    get: (provider) => Effect.sync(() => (reads.push(provider), stored[provider] ?? null)),
    set: () => Effect.void,
    remove: () => Effect.succeed(true),
  });
  return { layer, reads };
};

const resolve = (provider: Provider, env: Record<string, string>, stored: Partial<Record<Provider, string>>) => {
  const keychain = fakeKeychain(stored);
  return Effect.runPromise(resolveCredential(provider, env).pipe(Effect.provide(keychain.layer))).then(
    (credential) => ({
      credential,
      reads: keychain.reads,
    }),
  );
};

describe("resolveCredential", () => {
  it("prefers the environment variable over the keychain", async () => {
    const { credential, reads } = await resolve("openai", { OPENAI_API_KEY: "env-key" }, { openai: "keychain-key" });
    expect(credential.source).toBe("environment");
    expect(credential.key && Redacted.value(credential.key)).toBe("env-key");
    expect(reads).toEqual([]);
  });

  it("falls back to the keychain when the variable is empty", async () => {
    const { credential } = await resolve("openrouter", { OPENROUTER_API_KEY: "  " }, { openrouter: "keychain-key" });
    expect(credential.source).toBe("keychain");
  });

  it("never reads a developer keychain in CI", async () => {
    const { credential, reads } = await resolve("openai", { CI: "true" }, { openai: "keychain-key" });
    expect(credential).toEqual({ provider: "openai", source: "missing", key: null });
    expect(reads).toEqual([]);
  });

  it("does not print the key when the credential is logged or serialised", async () => {
    const { credential } = await resolve("openai", { OPENAI_API_KEY: "sk-secret-value" }, {});
    expect(JSON.stringify(credential)).not.toContain("sk-secret-value");
    expect(String(credential.key)).not.toContain("sk-secret-value");
  });
});

describe("preferences", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "katalepsis-prefs-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("saves provider and model readable only by the user, with no other fields", async () => {
    const env = { KATALEPSIS_HOME: path.join(home, "config") };
    const file = await Effect.runPromise(savePreferences(env, { provider: "openrouter", model: "vendor/model-1" }));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ provider: "openrouter", model: "vendor/model-1" });
    expect(await Effect.runPromise(loadPreferences(env))).toEqual({ provider: "openrouter", model: "vendor/model-1" });
  });

  it("returns empty preferences when no file exists", async () => {
    expect(await Effect.runPromise(loadPreferences({ KATALEPSIS_HOME: home }))).toEqual({});
  });
});

describe("resolveModelChoice", () => {
  it("lets flags override the environment, and the environment override saved preferences", () => {
    const saved = { provider: "openai" as const, model: "saved-model" };
    expect(resolveModelChoice(saved, { KATALEPSIS_MODEL: "env-model" }, { provider: null, model: null })).toEqual({
      provider: "openai",
      model: "env-model",
    });
    expect(
      resolveModelChoice(saved, { KATALEPSIS_MODEL: "env-model" }, { provider: "openrouter", model: "flag-model" }),
    ).toEqual({
      provider: "openrouter",
      model: "flag-model",
    });
  });

  it("has no default model", () => {
    expect(resolveModelChoice({ provider: "openai" }, {}, { provider: null, model: null })).toEqual({
      missing: "No model chosen. Run `katalepsis config model <model-id>`.",
    });
  });

  it("rejects an unknown provider", () => {
    expect(resolveModelChoice({}, { KATALEPSIS_PROVIDER: "acme" }, { provider: null, model: "m" })).toHaveProperty(
      "missing",
    );
  });
});

describe("empty settings", () => {
  it("treats empty environment values as unset", () => {
    expect(
      resolveModelChoice(
        { provider: "openai", model: "saved" },
        { KATALEPSIS_PROVIDER: "", KATALEPSIS_MODEL: " " },
        { provider: null, model: null },
      ),
    ).toEqual({ provider: "openai", model: "saved" });
  });
});
