import { describe, expect, it } from "vitest";
import { aggregateStatus, type RunError } from "../src/index.ts";

const runError: RunError = { category: "infrastructure", message: "boom", stage: "playwright-run", retryable: false };

describe("aggregateStatus", () => {
  it("fails when any check failed, even if others are blocked", () => {
    expect(aggregateStatus([{ status: "passed" }, { status: "blocked" }, { status: "failed" }], [])).toBe("failed");
  });

  it("blocks when a check is blocked and none failed", () => {
    expect(aggregateStatus([{ status: "passed" }, { status: "blocked" }], [])).toBe("blocked");
  });

  it("never passes an empty run", () => {
    expect(aggregateStatus([], [])).toBe("blocked");
  });

  it("blocks a run with passing checks when the run itself reported an error", () => {
    expect(aggregateStatus([{ status: "passed" }], [runError])).toBe("blocked");
  });

  it("passes only when every check passed", () => {
    expect(aggregateStatus([{ status: "passed" }, { status: "passed" }], [])).toBe("passed");
  });
});
