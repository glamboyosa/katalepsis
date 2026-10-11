import { Schema } from "effect";

/** Providers supported for agent checks. Google and OpenAI-compatible endpoints come later. */
export const Provider = Schema.Literals(["anthropic", "openai", "openrouter"]);
export type Provider = typeof Provider.Type;

export const PROVIDERS: ReadonlyArray<Provider> = Provider.literals;

export const ENV_VAR: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export const isProvider = Schema.is(Provider);
