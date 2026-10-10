import { describe, expect, it } from "vitest";
import { decideOutcome, type AssertionRecord } from "../src/index.ts";

const record = (overrides: Partial<AssertionRecord>): AssertionRecord => ({
  id: "a1",
  expectation: "visible",
  description: 'text "Thanks" is visible',
  passed: true,
  detail: "1 visible match",
  trueAtStart: false,
  ...overrides,
});

const shown = record({});
const missing = record({
  id: "a2",
  description: 'text "required" is visible',
  passed: false,
  detail: "0 visible matches",
});
const verdict = (value: "passed" | "failed" | "blocked", assertionIds: ReadonlyArray<string>) => ({
  verdict: value,
  summary: "",
  assertionIds,
});

describe("decideOutcome", () => {
  it("passes when a cited visible assertion shows a change the agent caused", () => {
    const outcome = decideOutcome(verdict("passed", ["a1"]), [shown], null, false);
    expect(outcome.status).toBe("passed");
    expect(outcome.cited).toEqual([shown]);
  });

  it("blocks a claimed pass that cites no assertion", () => {
    expect(decideOutcome(verdict("passed", []), [shown], null, false).failure?.code).toBe("no-evidence");
  });

  it("blocks a claimed pass when a cited assertion failed", () => {
    expect(decideOutcome(verdict("passed", ["a1", "a2"]), [shown, missing], null, false).status).toBe("blocked");
  });

  it("allows failed guesses before the cited evidence", () => {
    const guess = record({ id: "a1", description: 'text "Success" is visible', passed: false });
    const found = record({ id: "a2" });
    expect(decideOutcome(verdict("passed", ["a2"]), [guess, found], null, false).status).toBe("passed");
  });

  it("blocks a pass when an uncited assertion after the cited one failed", () => {
    const outcome = decideOutcome(verdict("passed", ["a1"]), [shown, missing], null, false);
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toContain("a later assertion failed: a2");
  });

  it.each([
    ["hidden", record({ expectation: "hidden", description: 'text "zzz" is hidden', trueAtStart: null })],
    ["url-includes", record({ expectation: "url-includes", description: 'URL contains "/"', trueAtStart: null })],
  ])("blocks a pass supported only by a %s assertion", (_label, assertion) => {
    const outcome = decideOutcome(verdict("passed", ["a1"]), [assertion], null, false);
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toContain("needs something visible");
  });

  it("blocks a pass citing only what was on the page before the agent acted", () => {
    const heading = record({ description: 'role "heading" named "Create an account" is visible', trueAtStart: true });
    const outcome = decideOutcome(verdict("passed", ["a1"]), [heading], null, false);
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toContain("already on the page");
  });

  it("blocks a pass about the start page even when the agent did nothing", () => {
    const heading = record({ trueAtStart: true });
    expect(decideOutcome(verdict("passed", ["a1"]), [heading], null, false).status).toBe("blocked");
  });

  it("accepts a pass about the start page for a check marked observeOnly", () => {
    const heading = record({ trueAtStart: true });
    expect(decideOutcome(verdict("passed", ["a1"]), [heading], null, true).status).toBe("passed");
  });

  it("blocks a verdict citing an assertion that never ran", () => {
    const outcome = decideOutcome(verdict("passed", ["a9"]), [shown], null, false);
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toContain("a9");
  });

  it("fails when a cited assertion failed and the agent reports failure", () => {
    const outcome = decideOutcome(verdict("failed", ["a2"]), [missing], null, false);
    expect(outcome.status).toBe("failed");
    expect(outcome.failure).toEqual({ code: "assertion", message: 'text "required" is visible' });
  });

  it("blocks a claimed failure whose cited assertions all passed", () => {
    expect(decideOutcome(verdict("failed", ["a1"]), [shown], null, false).status).toBe("blocked");
  });

  it("blocks when the loop was interrupted, whatever was asserted", () => {
    const outcome = decideOutcome(null, [shown], { code: "budget", message: "out of steps" }, false);
    expect(outcome).toMatchObject({ status: "blocked", failure: { code: "budget", message: "out of steps" } });
  });

  it("blocks when there is no verdict", () => {
    expect(decideOutcome(null, [shown], null, false).failure?.code).toBe("no-evidence");
  });
});
