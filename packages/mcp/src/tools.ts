import { ChecksFile } from "@katalepsis/agent";
import { Schema } from "effect";

// Tool inputs. optionalKey keeps unused fields out of the JSON Schema instead of advertising
// null, which some clients send and the validator would then reject.
const Url = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2000));
const ProjectPath = Schema.String.check(Schema.isMaxLength(500));

export const RunTestsInput = Schema.Struct({
  baseUrl: Url,
  cwd: Schema.optionalKey(ProjectPath),
  project: Schema.optionalKey(Schema.Array(Schema.String)),
  grep: Schema.optionalKey(Schema.String),
  timeoutSeconds: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3600 }))),
  installBrowsers: Schema.optionalKey(Schema.Boolean),
});
export type RunTestsInput = typeof RunTestsInput.Type;

export const CheckBrowserInput = Schema.Struct({
  baseUrl: Url,
  // The checks file schema, so duplicate IDs and bad fields are rejected the same way.
  checks: ChecksFile.fields.checks,
  cwd: Schema.optionalKey(ProjectPath),
  provider: Schema.optionalKey(Schema.Literals(["openai", "openrouter"])),
  model: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
  allowOrigins: Schema.optionalKey(Schema.Array(Url)),
});
export type CheckBrowserInput = typeof CheckBrowserInput.Type;

export const GetReportInput = Schema.Struct({
  runId: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}$/)),
  cwd: Schema.optionalKey(ProjectPath),
  format: Schema.optionalKey(Schema.Literals(["summary", "markdown", "manifest"])),
});
export type GetReportInput = typeof GetReportInput.Type;

/** Marks every object closed, matching the server, which rejects unknown keys. */
const closeObjects = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(closeObjects);
  if (typeof node !== "object" || node === null) return node;
  const entries = Object.entries(node).map(([key, value]) => [key, closeObjects(value)] as const);
  const result: Record<string, unknown> = Object.fromEntries(entries);
  if (result["type"] === "object" && "properties" in result) result["additionalProperties"] = false;
  return result;
};

const jsonSchema = (schema: Schema.Top): Record<string, unknown> => {
  const document = Schema.toStandardJSONSchemaV1(schema)["~standard"].jsonSchema.input({ target: "draft-07" });
  const { $schema: _ignored, ...rest } = closeObjects(document) as Record<string, unknown>;
  return rest;
};

export const TOOLS = [
  {
    name: "verification_run_tests",
    title: "Run Playwright tests against a preview",
    description:
      "Runs the project's existing Playwright tests against a preview URL and writes a katalepsis report. Returns passed, failed, blocked and not-tested counts, each check's result and the report paths. Needs no AI key. Can take minutes. Set installBrowsers to run the project's own playwright install first, for example after a result says a browser could not start.",
    inputSchema: jsonSchema(RunTestsInput),
  },
  {
    name: "verification_check_browser",
    title: "Run agent checks against a preview",
    description:
      "Runs plain-language checks in a real browser using the user's locally configured OpenAI or OpenRouter key. Each check needs id (lowercase letters, digits and hyphens, unique), name, intent and passCondition, and may set startPath (a path starting with /) and observeOnly. A check passes only when browser assertions prove it. Never pass API keys; they are read from the user's environment or keychain.",
    inputSchema: jsonSchema(CheckBrowserInput),
  },
  {
    name: "verification_get_report",
    title: "Read an existing katalepsis report",
    description:
      "Returns a report written by an earlier run: a summary, the Markdown report, or the full manifest. runId is the runId returned by the run tools, such as 2026-10-10T13-09-00-026Z-0aadc0.",
    inputSchema: jsonSchema(GetReportInput),
  },
] as const;
