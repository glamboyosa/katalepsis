import {
  APICallError,
  hasToolCall,
  isStepCount,
  jsonSchema,
  RetryError,
  ToolLoopAgent,
  tool,
  type FlexibleSchema,
  type LanguageModel,
  type StopCondition,
  type ToolSet,
} from "ai";
import { Schema } from "effect";
import type { CheckSession } from "./browser.ts";
import { ROLES } from "./browser.ts";
import type { AgentCheck } from "./checks.ts";
import type { Interruption, Verdict } from "./outcome.ts";

export type Budget = {
  readonly maxSteps: number;
  readonly maxTotalTokens: number;
  readonly timeoutMs: number;
};

export type AgentRunResult = {
  readonly verdict: Verdict | null;
  readonly interruption: Interruption | null;
  readonly totalTokens: number;
  readonly steps: number;
};

/**
 * Adapts an Effect schema for the AI SDK, which needs both Standard Schema validation
 * and a Standard JSON Schema converter on the same object.
 */
const schema = <S extends Schema.Codec<unknown, unknown>>(value: S): FlexibleSchema<S["Type"]> => {
  const validation = Schema.toStandardSchemaV1(value)["~standard"];
  const json = Schema.toStandardJSONSchemaV1(value)["~standard"];
  return { "~standard": { ...validation, jsonSchema: json.jsonSchema } } as FlexibleSchema<S["Type"]>;
};

const Role = Schema.Literals(ROLES);
// optionalKey, not optional: optional advertises null in the JSON Schema but rejects it,
// so a model that sends null for an unused field would fail validation.
const TargetFields = {
  role: Schema.optionalKey(Role),
  name: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
};

// Effect renders an empty struct as "anything but null"; OpenAI requires an object schema.
const NO_INPUT = jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false });

const INSTRUCTIONS = `You verify one behaviour of a web page in a real browser.
Work only through the tools. Start with snapshot to read the page.
To decide the result you must call assert. The assertion runs in the browser and its result is final; your opinion is not evidence.
Assert the pass condition directly: for "an error is visible", assert the error message itself.
Assertions match exactly. After acting, take a snapshot and copy the element's full text or accessible name from it; do not guess wording.
Do not cite anything that was already on the page before you acted, such as a heading or a field label.
When you are done, call finish exactly once with your verdict and the IDs of the assertions that support it:
- passed: every cited assertion passed and together they show the pass condition holds;
- failed: a cited assertion failed and shows the pass condition does not hold;
- blocked: you could not reach a point where the pass condition can be checked.
Use only synthetic test data such as "Test Person" and "test.person@example.com". Never enter real personal data or secrets.`;

const toolsFor = (session: CheckSession, onFinish: (verdict: Verdict) => void) =>
  ({
    navigate: tool({
      description: "Open a path or URL on the preview site. Other sites are refused.",
      inputSchema: schema(Schema.Struct({ target: Schema.String })),
      execute: ({ target }) => session.navigate(target),
    }),
    snapshot: tool({
      description: "Read the page as an accessibility tree: roles, names and text.",
      inputSchema: NO_INPUT,
      execute: () => session.snapshot(),
    }),
    click: tool({
      description: "Click the first element matching a role and accessible name, or a visible text.",
      inputSchema: schema(Schema.Struct(TargetFields)),
      execute: (target) => session.click(target),
    }),
    fill: tool({
      description: "Type a value into the form field with this label.",
      inputSchema: schema(Schema.Struct({ label: Schema.String, value: Schema.String })),
      execute: ({ label, value }) => session.fill(label, value),
    }),
    press: tool({
      description: "Press a keyboard key, such as Enter or Tab.",
      inputSchema: schema(Schema.Struct({ key: Schema.String })),
      execute: ({ key }) => session.press(key),
    }),
    assert: tool({
      description:
        "Check the page in the browser and record the result as evidence. Matching is exact: use an element's full text or accessible name. visible: such an element is shown. hidden: no such element is shown. url-includes: the URL contains value.",
      inputSchema: schema(
        Schema.Struct({
          expectation: Schema.Literals(["visible", "hidden", "url-includes"]),
          ...TargetFields,
          value: Schema.optionalKey(Schema.String),
        }),
      ),
      execute: async ({ expectation, ...target }) => {
        const record = await session.assert(expectation, target);
        return `${record.id}: ${record.description}: ${record.passed ? "PASSED" : "FAILED"} (${record.detail})`;
      },
    }),
    finish: tool({
      description: "Report the verdict once, citing assertion IDs such as a1.",
      inputSchema: schema(
        Schema.Struct({
          verdict: Schema.Literals(["passed", "failed", "blocked"]),
          summary: Schema.String,
          assertionIds: Schema.Array(Schema.String),
        }),
      ),
      execute: (verdict) => {
        onFinish(verdict);
        return "Recorded.";
      },
    }),
  }) satisfies ToolSet;

type Progress = { steps: number; totalTokens: number };

/**
 * Stops the loop once the steps so far have used `maxTotalTokens`. It also records usage
 * after every step, so a run that later fails still reports what it spent.
 */
const tokenBudget =
  (maxTotalTokens: number, progress: Progress): StopCondition<ToolSet> =>
  ({ steps }) => {
    progress.steps = steps.length;
    progress.totalTokens = steps.reduce((total, step) => total + (step.usage.totalTokens ?? 0), 0);
    return progress.totalTokens >= maxTotalTokens;
  };

/** Classifies a model or transport error without echoing request bodies. */
export const describeModelError = (error: unknown): Interruption => {
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  if (APICallError.isInstance(cause)) {
    const status = cause.statusCode;
    if (status === 401 || status === 403) {
      return {
        code: "model",
        message: `The provider rejected the API key (HTTP ${status}). Check it with \`katalepsis auth status\`.`,
      };
    }
    if (status === 404) return { code: "model", message: "The provider does not know this model (HTTP 404)." };
    if (status === 429)
      return {
        code: "budget",
        message: "The provider rate-limited the request or the account is out of credit (HTTP 429).",
      };
    return { code: "model", message: `The model request failed (HTTP ${status ?? "unknown"}): ${cause.message}` };
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return { code: "budget", message: "The check ran out of time." };
  }
  return { code: "error", message: `The agent failed: ${error instanceof Error ? error.message : String(error)}` };
};

/**
 * Runs the tool loop for one check. Limits on steps, tokens and time are enforced here,
 * and a loop that ends without `finish` returns no verdict, which the caller blocks.
 */
export const runCheck = async (
  model: LanguageModel,
  check: AgentCheck,
  session: CheckSession,
  budget: Budget,
  signal: AbortSignal,
): Promise<AgentRunResult> => {
  let verdict: Verdict | null = null;
  const progress: Progress = { steps: 0, totalTokens: 0 };
  const agent = new ToolLoopAgent({
    model,
    instructions: INSTRUCTIONS,
    tools: toolsFor(session, (reported) => {
      verdict ??= reported;
    }),
    stopWhen: [isStepCount(budget.maxSteps), hasToolCall("finish"), tokenBudget(budget.maxTotalTokens, progress)],
    maxRetries: 1,
  });
  const prompt = `Check: ${check.name}
What to do: ${check.intent}
Pass condition: ${check.passCondition}
The page is already open at ${check.startPath ?? "the preview's start page"}.`;

  try {
    const result = await agent.generate({ prompt, abortSignal: signal, timeout: budget.timeoutMs });
    const totalTokens = result.totalUsage.totalTokens ?? 0;
    const steps = result.steps.length;
    if (verdict !== null) return { verdict, interruption: null, totalTokens, steps };
    const interruption: Interruption =
      totalTokens >= budget.maxTotalTokens
        ? { code: "budget", message: `The agent used its token budget (${budget.maxTotalTokens}) without a verdict.` }
        : steps >= budget.maxSteps
          ? { code: "budget", message: `The agent used its ${budget.maxSteps} steps without a verdict.` }
          : { code: "model", message: "The model stopped without calling finish." };
    return { verdict: null, interruption, totalTokens, steps };
  } catch (error) {
    const interruption: Interruption = signal.aborted
      ? { code: "interrupted", message: "The run was cancelled during this check." }
      : describeModelError(error);
    return {
      verdict,
      interruption: verdict === null ? interruption : null,
      totalTokens: progress.totalTokens,
      steps: progress.steps,
    };
  }
};
