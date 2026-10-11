import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { ModelChoice, Provider } from "@katalepsis/credentials";
import type { LanguageModel } from "ai";
import { Redacted } from "effect";

const CATALOG_TIMEOUT_MS = 10_000;

const CATALOG_URL: Record<Provider, string> = {
  // Anthropic pages its catalog at 20 models by default; 1000 is its maximum page size.
  anthropic: "https://api.anthropic.com/v1/models?limit=1000",
  openai: "https://api.openai.com/v1/models",
  openrouter: "https://openrouter.ai/api/v1/models",
};

/** Builds the AI SDK model for a provider with the user's own key. */
export const createModel = (choice: ModelChoice, key: Redacted.Redacted<string>): LanguageModel => {
  if (choice.provider === "anthropic") return createAnthropic({ apiKey: Redacted.value(key) })(choice.model);
  if (choice.provider === "openai") return createOpenAI({ apiKey: Redacted.value(key) })(choice.model);
  return createOpenRouter({ apiKey: Redacted.value(key), compatibility: "strict" })(choice.model);
};

export type ModelValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: "credentials" | "configuration"; readonly message: string };

// OpenRouter's model list is public, so a separate authenticated call checks the key itself.
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";

/** Anthropic takes its key in x-api-key with a pinned API version; the others use a bearer token. */
const authHeaders = (provider: Provider, key: Redacted.Redacted<string>): Record<string, string> =>
  provider === "anthropic"
    ? { "x-api-key": Redacted.value(key), "anthropic-version": "2023-06-01" }
    : { authorization: `Bearer ${Redacted.value(key)}` };

const isModelList = (body: unknown): body is { data: Array<{ id: unknown }> } =>
  typeof body === "object" && body !== null && "data" in body && Array.isArray(body.data);

/**
 * Confirms the model ID exists in the provider's catalog before any check runs, so a typo
 * fails fast with a clear message instead of as a blocked check per check.
 */
export const validateModel = async (
  choice: ModelChoice,
  key: Redacted.Redacted<string>,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelValidation> => {
  const get = (url: string) =>
    fetchImpl(url, {
      headers: authHeaders(choice.provider, key),
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
  const unreachable = (error: unknown): ModelValidation => ({
    ok: false,
    kind: "configuration",
    message: `Could not reach ${choice.provider}: ${error instanceof Error ? error.message : String(error)}`,
  });
  const unknownModel = (): ModelValidation => ({
    ok: false,
    kind: "configuration",
    message: `${choice.provider} has no model "${choice.model}". List models with \`katalepsis models ${choice.provider}\`.`,
  });
  const rejected = (status: number): ModelValidation => ({
    ok: false,
    kind: "credentials",
    message: `${choice.provider} rejected the API key (HTTP ${status}).`,
  });

  // Anthropic's catalog lists dated IDs but not aliases such as claude-sonnet-4-5, which the
  // API accepts. Looking the model up directly resolves both.
  if (choice.provider === "anthropic") {
    const lookup = await get(`https://api.anthropic.com/v1/models/${encodeURIComponent(choice.model)}`).catch(
      (error: unknown) => error,
    );
    if (!(lookup instanceof Response)) return unreachable(lookup);
    if (lookup.status === 401 || lookup.status === 403) return rejected(lookup.status);
    if (lookup.status === 404) return unknownModel();
    if (!lookup.ok)
      return {
        ok: false,
        kind: "configuration",
        message: `${choice.provider} answered HTTP ${lookup.status} for the model lookup.`,
      };
    return { ok: true };
  }

  if (choice.provider === "openrouter") {
    const keyCheck = await get(OPENROUTER_KEY_URL).catch((error: unknown) => error);
    if (!(keyCheck instanceof Response)) return unreachable(keyCheck);
    if (keyCheck.status === 401 || keyCheck.status === 403) return rejected(keyCheck.status);
  }

  const response = await get(CATALOG_URL[choice.provider]).catch((error: unknown) => error);
  if (!(response instanceof Response)) return unreachable(response);
  if (response.status === 401 || response.status === 403) return rejected(response.status);
  if (!response.ok) {
    return {
      ok: false,
      kind: "configuration",
      message: `The ${choice.provider} model catalog answered HTTP ${response.status}.`,
    };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!isModelList(body)) {
    return {
      ok: false,
      kind: "configuration",
      message: `The ${choice.provider} model catalog had an unexpected shape.`,
    };
  }
  const ids = body.data.map((model) => model.id).filter((id): id is string => typeof id === "string");
  return ids.includes(choice.model) ? { ok: true } : unknownModel();
};

/** Lists model IDs from the provider's catalog, for `katalepsis models`. */
export const listModels = async (
  provider: Provider,
  key: Redacted.Redacted<string> | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ReadonlyArray<string>> => {
  const response = await fetchImpl(CATALOG_URL[provider], {
    headers: key === null ? {} : authHeaders(provider, key),
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `${provider} rejected the key (HTTP ${response.status}). Check it with \`katalepsis auth status\`.`,
    );
  }
  if (!response.ok) throw new Error(`The ${provider} model catalog answered HTTP ${response.status}.`);
  const body: unknown = await response.json();
  if (!isModelList(body)) throw new Error(`The ${provider} model catalog had an unexpected shape.`);
  return body.data
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string")
    .toSorted();
};
