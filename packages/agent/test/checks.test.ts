import { describe, expect, it } from "vitest";
import { parseChecksFile } from "../src/index.ts";

const check = { id: "empty-form", name: "Empty form", intent: "Submit it empty", passCondition: "An error is visible" };

describe("parseChecksFile", () => {
  it("accepts the documented shape", () => {
    expect(parseChecksFile(JSON.stringify({ checks: [check] })).checks[0]?.id).toBe("empty-form");
  });

  it.each([
    ["free-form prose", "Check that the form works", /not valid JSON/],
    ["a missing pass condition", JSON.stringify({ checks: [{ ...check, passCondition: undefined }] }), /passCondition/],
    ["an empty pass condition", JSON.stringify({ checks: [{ ...check, passCondition: "" }] }), /passCondition/],
    ["duplicate IDs", JSON.stringify({ checks: [check, check] }), /used more than once/],
    ["an ID that is not a slug", JSON.stringify({ checks: [{ ...check, id: "../x" }] }), /id/],
    ["no checks", JSON.stringify({ checks: [] }), /checks/],
  ])("rejects %s", (_label, text, message) => {
    expect(() => parseChecksFile(text)).toThrow(message);
  });
});
