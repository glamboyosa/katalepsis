import { MockLanguageModelV4 } from "ai/test";

export type ScriptedCall = { readonly tool: string; readonly input: Record<string, unknown> };
/** One model step: a single tool call, or several issued together as real models do. */
export type ScriptedStep = ScriptedCall | ReadonlyArray<ScriptedCall>;

const usage = (tokens: number) => ({
  inputTokens: { total: tokens, noCache: tokens, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 0, text: 0, reasoning: undefined },
});

/**
 * A fake model that makes one scripted tool call per step and repeats the last one when the
 * script runs out. It stands in for a provider so tests need no key and no network.
 */
export const scriptedModel = (script: ReadonlyArray<ScriptedStep>, tokensPerStep = 100) => {
  let step = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const entry = script[Math.min(step, script.length - 1)];
      step += 1;
      if (entry === undefined) throw new Error("empty script");
      const calls: ReadonlyArray<ScriptedCall> = "tool" in entry ? [entry] : entry;
      return {
        content: calls.map((call, index) => ({
          type: "tool-call" as const,
          toolCallId: `call-${step}-${index}`,
          toolName: call.tool,
          input: JSON.stringify(call.input),
        })),
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: usage(tokensPerStep),
        warnings: [],
      };
    },
  });
};
