import type { CheckStatus, RunError, VerificationCheck } from "./schema.ts";

/**
 * Computes the run status. Any failed check fails the run. Otherwise a blocked check,
 * a run-level error or an empty run blocks it. A run passes only when it ran at least
 * one check and every check passed.
 */
export const aggregateStatus = (
  checks: ReadonlyArray<Pick<VerificationCheck, "status">>,
  errors: ReadonlyArray<RunError>,
): CheckStatus => {
  if (checks.some((check) => check.status === "failed")) return "failed";
  if (checks.length === 0 || errors.length > 0) return "blocked";
  if (checks.some((check) => check.status === "blocked")) return "blocked";
  return "passed";
};
