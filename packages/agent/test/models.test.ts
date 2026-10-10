import { APICallError } from "ai";
import { Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { describeModelError, validateModel } from "../src/index.ts";

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
