import { APICallError } from "ai";
import { Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { createModel, describeModelError, listModels, validateModel } from "../src/index.ts";

const key = Redacted.make("sk-test-key");

/** A fake fetch that answers by URL. */
const routes =
  (table: Record<string, [number, unknown]>): typeof fetch =>
  async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const [status, body] = table[url] ?? [404, {}];
    return new Response(JSON.stringify(body), { status });
  };

const OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models";
const OPENROUTER_KEY = "https://openrouter.ai/api/v1/key";
const OPENAI_MODELS = "https://api.openai.com/v1/models";
const ANTHROPIC_MODELS = "https://api.anthropic.com/v1/models?limit=1000";

describe("validateModel", () => {
  it("accepts a model listed in the catalog with a working key", async () => {
    const fetchImpl = routes({
      [OPENROUTER_KEY]: [200, { data: {} }],
      [OPENROUTER_MODELS]: [200, { data: [{ id: "vendor/a" }] }],
    });
    expect(await validateModel({ provider: "openrouter", model: "vendor/a" }, key, fetchImpl)).toEqual({ ok: true });
  });

  it("rejects a bad OpenRouter key even though its model list is public", async () => {
    const fetchImpl = routes({
      [OPENROUTER_KEY]: [401, {}],
      [OPENROUTER_MODELS]: [200, { data: [{ id: "vendor/a" }] }],
    });
    expect(await validateModel({ provider: "openrouter", model: "vendor/a" }, key, fetchImpl)).toEqual({
      ok: false,
      kind: "credentials",
      message: "openrouter rejected the API key (HTTP 401).",
    });
  });

  it("rejects a model that is not in the catalog as a configuration problem", async () => {
    const result = await validateModel(
      { provider: "openai", model: "turkey-7b" },
      key,
      routes({ [OPENAI_MODELS]: [200, { data: [{ id: "real" }] }] }),
    );
    expect(result).toMatchObject({ ok: false, kind: "configuration" });
  });

  it("reports a rejected OpenAI key as a credentials problem without echoing it", async () => {
    const result = await validateModel({ provider: "openai", model: "m" }, key, routes({ [OPENAI_MODELS]: [401, {}] }));
    expect(result).toEqual({ ok: false, kind: "credentials", message: "openai rejected the API key (HTTP 401)." });
  });
});

const CLAUDE_MODELS = ["claude-haiku-5-5-20260601", "claude-sonnet-5-5-20260601"];
const CLAUDE_ALIASES: Record<string, string> = { "claude-sonnet-5-5": "claude-sonnet-5-5-20260601" };

/** Anthropic's models API: the list, and lookup by ID or alias. Needs its key header and API version. */
const anthropicApi: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers);
  if (
    headers.get("x-api-key") !== "sk-test-key" ||
    headers.get("anthropic-version") !== "2023-06-01" ||
    headers.has("authorization")
  )
    return new Response("{}", { status: 401 });
  if (url === ANTHROPIC_MODELS) return new Response(JSON.stringify({ data: CLAUDE_MODELS.map((id) => ({ id })) }));
  const requested = decodeURIComponent(url.replace("https://api.anthropic.com/v1/models/", ""));
  const id = CLAUDE_ALIASES[requested] ?? requested;
  return CLAUDE_MODELS.includes(id) ? new Response(JSON.stringify({ id })) : new Response("{}", { status: 404 });
};

describe("Anthropic catalog", () => {
  it("validates a dated Claude model ID with the key in x-api-key", async () => {
    expect(
      await validateModel({ provider: "anthropic", model: "claude-sonnet-5-5-20260601" }, key, anthropicApi),
    ).toEqual({ ok: true });
  });

  it("accepts an alias the catalog list does not show", async () => {
    expect(await validateModel({ provider: "anthropic", model: "claude-sonnet-5-5" }, key, anthropicApi)).toEqual({
      ok: true,
    });
  });

  it("rejects a Claude model that is not in the catalog", async () => {
    expect(await validateModel({ provider: "anthropic", model: "claude-imaginary" }, key, anthropicApi)).toMatchObject({
      ok: false,
      kind: "configuration",
    });
  });

  it("reports a rejected Anthropic key as a credentials problem", async () => {
    expect(
      await validateModel({ provider: "anthropic", model: "claude-sonnet-5-5" }, Redacted.make("wrong"), anthropicApi),
    ).toEqual({ ok: false, kind: "credentials", message: "anthropic rejected the API key (HTTP 401)." });
  });

  it("builds an Anthropic model for the anthropic provider", () => {
    const model = createModel({ provider: "anthropic", model: "claude-sonnet-5-5" }, key);
    expect(typeof model === "object" && model.provider).toMatch(/^anthropic/);
  });

  it("lists Claude model IDs", async () => {
    expect(await listModels("anthropic", key, anthropicApi)).toEqual(CLAUDE_MODELS);
  });
});

const apiError = (statusCode: number) =>
  new APICallError({
    message: "provider said no",
    url: "https://x",
    requestBodyValues: { prompt: "secret prompt" },
    statusCode,
  });

describe("describeModelError", () => {
  it.each([
    [401, "model", /rejected the API key/],
    [404, "model", /does not know this model/],
    [429, "budget", /rate-limited/],
    [500, "model", /HTTP 500/],
  ])("classifies HTTP %i", (status, code, message) => {
    const interruption = describeModelError(apiError(status));
    expect(interruption.code).toBe(code);
    expect(interruption.message).toMatch(message);
    expect(interruption.message).not.toContain("secret prompt");
  });
});
