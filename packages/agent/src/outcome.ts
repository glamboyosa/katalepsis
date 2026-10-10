import type { CheckStatus, FailureCode } from "@katalepsis/core";

/** A deterministic browser assertion run by katalepsis, not by the model. */
export type AssertionRecord = {
  readonly id: string;
  readonly expectation: "visible" | "hidden" | "url-includes";
  readonly description: string;
  readonly passed: boolean;
  readonly detail: string;
  /**
   * For "visible" assertions: whether the same element was already visible on an untouched
   * copy of the start page. Null for other expectations.
   */
  readonly trueAtStart: boolean | null;
};

export type Verdict = {
  readonly verdict: "passed" | "failed" | "blocked";
  readonly summary: string;
  readonly assertionIds: ReadonlyArray<string>;
};

/** Why the agent loop ended without a usable verdict. */
export type Interruption =
  | { readonly code: "budget"; readonly message: string }
  | { readonly code: "model"; readonly message: string }
  | { readonly code: "navigation"; readonly message: string }
  | { readonly code: "interrupted"; readonly message: string }
  | { readonly code: "error"; readonly message: string };

export type Outcome = {
  readonly status: CheckStatus;
  readonly failure: { readonly code: FailureCode; readonly message: string } | null;
  readonly cited: ReadonlyArray<AssertionRecord>;
  readonly reason: string;
};

const blocked = (code: FailureCode, reason: string, cited: ReadonlyArray<AssertionRecord> = []): Outcome => ({
  status: "blocked",
  failure: { code, message: reason },
  cited,
  reason,
});

/** Why a claimed pass is not supported, or null when it is. */
const passGap = (
  cited: ReadonlyArray<AssertionRecord>,
  assertions: ReadonlyArray<AssertionRecord>,
  observeOnly: boolean,
): string | null => {
  if (!cited.every((assertion) => assertion.passed)) return "The agent reported a pass, but a cited assertion failed.";
  // Failed guesses before the cited evidence are normal: a model often tries a few wordings
  // before it finds the real message. A failure after it means the latest evidence disagrees.
  const position = (assertion: AssertionRecord) => assertions.indexOf(assertion);
  const lastCited = Math.max(...cited.map(position));
  const citedIds = new Set(cited.map((assertion) => assertion.id));
  const laterFailures = assertions.filter(
    (assertion) => !assertion.passed && !citedIds.has(assertion.id) && position(assertion) > lastCited,
  );
  if (laterFailures.length > 0) {
    return `The agent reported a pass, but a later assertion failed: ${laterFailures.map((assertion) => assertion.id).join(", ")}.`;
  }
  const shown = cited.filter((assertion) => assertion.expectation === "visible");
  if (shown.length === 0) {
    return "The agent reported a pass citing only hidden or URL assertions. A pass needs something visible on the page.";
  }
  if (!observeOnly && shown.every((assertion) => assertion.trueAtStart === true)) {
    return "The agent reported a pass, but everything it cited was already on the page before it acted.";
  }
  return null;
};

/**
 * Decides a check's status from evidence. The model's verdict is a claim; katalepsis
 * accepts it only when the browser assertions it cites agree:
 * - passed needs every cited assertion to pass, no uncited assertion failing after them, and
 *   at least one cited "visible" assertion that was not already visible before the agent
 *   acted. A check marked `observeOnly` is about the page as it loads, so that last part
 *   does not apply;
 * - failed needs at least one cited assertion that failed;
 * - anything else, including no verdict at all, is blocked.
 */
export const decideOutcome = (
  verdict: Verdict | null,
  assertions: ReadonlyArray<AssertionRecord>,
  interruption: Interruption | null,
  observeOnly: boolean,
): Outcome => {
  if (interruption !== null) return blocked(interruption.code, interruption.message);
  if (verdict === null) return blocked("no-evidence", "The agent stopped without reporting a verdict.");

  const byId = new Map(assertions.map((assertion) => [assertion.id, assertion]));
  const unknown = verdict.assertionIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    return blocked("no-evidence", `The agent cited assertions that never ran: ${unknown.join(", ")}.`);
  }
  const cited = verdict.assertionIds.flatMap((id) => {
    const assertion = byId.get(id);
    return assertion === undefined ? [] : [assertion];
  });

  if (verdict.verdict === "blocked") {
    return blocked("no-evidence", `The agent reported it could not check this: ${verdict.summary}`, cited);
  }
  if (cited.length === 0) {
    return blocked("no-evidence", `The agent reported "${verdict.verdict}" without citing a browser assertion.`);
  }
  if (verdict.verdict === "passed") {
    const gap = passGap(cited, assertions, observeOnly);
    return gap === null
      ? {
          status: "passed",
          failure: null,
          cited,
          reason: "The cited assertions passed and show a change the agent caused.",
        }
      : blocked("no-evidence", gap, cited);
  }
  const failedAssertions = cited.filter((assertion) => !assertion.passed);
  return failedAssertions.length > 0
    ? {
        status: "failed",
        failure: { code: "assertion", message: failedAssertions.map((assertion) => assertion.description).join("; ") },
        cited,
        reason: "A cited assertion failed.",
      }
    : blocked("no-evidence", "The agent reported a failure, but every cited assertion passed.", cited);
};
