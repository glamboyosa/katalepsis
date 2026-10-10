import { Schema } from "effect";

/** Providers supported for agent checks. Anthropic, Google and OpenAI-compatible endpoints come later. */
export const Provider = Schema.Literals(["openai", "openrouter"]);
export type Provider = typeof Provider.Type;

export const PROVIDERS: ReadonlyArray<Provider> = Provider.literals;

export const ENV_VAR: Record<Provider, string> = {
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export const isProvider = Schema.is(Provider);
