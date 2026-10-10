import { Schema } from "effect";

const Text = (maxLength: number) => Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));

/** One agent check. The pass condition must describe something visible that a browser assertion can confirm. */
export const AgentCheck = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/)),
  name: Text(200),
  intent: Text(2000),
  passCondition: Text(1000),
  /**
   * Set for checks about the page as it loads, with nothing to do first. Without it, a pass
   * needs evidence of something that was not on the page at the start.
   */
  observeOnly: Schema.optionalKey(Schema.Boolean),
  /** Path on the preview to start from, such as "/signup". Defaults to the preview URL itself. */
  startPath: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\/(?!\/)/), Schema.isMaxLength(500))),
});
export type AgentCheck = typeof AgentCheck.Type;

export const MAX_CHECKS = 20;

export const ChecksFile = Schema.Struct({
  checks: Schema.Array(AgentCheck).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_CHECKS),
    Schema.makeFilter((checks: ReadonlyArray<AgentCheck>) => {
      const ids = checks.map((check) => check.id);
      const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
      return duplicate === undefined || `check id "${duplicate}" is used more than once`;
    }),
  ),
});
export type ChecksFile = typeof ChecksFile.Type;

/** Parses and validates a checks file. Free-form prose is rejected; every field is required up front. */
export const parseChecksFile = (text: string): ChecksFile => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Checks file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  return Schema.decodeUnknownSync(ChecksFile)(raw);
};
