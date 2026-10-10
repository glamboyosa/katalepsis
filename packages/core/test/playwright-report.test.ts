import { readFile } from "node:fs/promises";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { declaredTests, normalizePlaywrightReport, PlaywrightJsonReport } from "../src/index.ts";
import { report, result, test } from "./report-builders.ts";

const CONTEXT = { secrets: [], previewOrigin: "http://127.0.0.1:4173" };

const loadFixture = async () =>
  Schema.decodeUnknownSync(PlaywrightJsonReport)(
    JSON.parse(await readFile(new URL("./fixtures/signup-report.json", import.meta.url), "utf8")),
  );

describe("normalizePlaywrightReport with a real Playwright 1.63 report", () => {
  it("reports the demo signup suite as 2 passed and 1 failed", async () => {
    const normalized = normalizePlaywrightReport(await loadFixture(), CONTEXT);
    expect(normalized.checks.map((check) => [check.title, check.status])).toEqual([
      ["empty submission shows a required-field error", "failed"],
      ["valid submission shows a confirmation", "passed"],
      ["malformed email shows an email error and does not submit", "passed"],
    ]);
    expect(normalized.errors).toEqual([]);
  });

  it("keeps the assertion message without colour codes and classifies it", async () => {
    const [failed] = normalizePlaywrightReport(await loadFixture(), CONTEXT).checks;
    expect(failed?.failure?.code).toBe("assertion");
    expect(failed?.observed).toContain("Expected pattern: /required/i");
    expect(failed?.observed).not.toContain("\u001b");
    expect(failed?.titlePath).toEqual(["signup form", "empty submission shows a required-field error"]);
    expect(failed?.line).toBe(8);
  });

  it("collects the failed test's screenshot, video and trace as pending evidence", async () => {
    const normalized = normalizePlaywrightReport(await loadFixture(), CONTEXT);
    const failedId = normalized.checks[0]?.id;
    expect(normalized.attachments.filter((item) => item.checkId === failedId).map((item) => item.kind)).toEqual([
      "screenshot",
      "video",
      "log",
      "trace",
    ]);
  });
});

const failing = (message: string, status = "failed") =>
  normalizePlaywrightReport(
    report([
      {
        title: "loads the cart",
        tests: [test({ status: "unexpected", results: [result({ status, error: { message } })] })],
      },
    ]),
    CONTEXT,
  ).checks[0];

describe("normalizePlaywrightReport outcomes", () => {
  it("lists skipped tests as not tested with the skip reason", () => {
    const normalized = normalizePlaywrightReport(
      report([
        {
          title: "pays with a saved card",
          tests: [
            test({
              status: "skipped",
              annotations: [{ type: "skip", description: "needs a card fixture" }],
              results: [],
            }),
          ],
        },
      ]),
      CONTEXT,
    );
    expect(normalized.checks).toEqual([]);
    expect(normalized.notTested).toEqual([
      {
        title: "pays with a saved card",
        file: "checkout.spec.ts",
        project: "chromium",
        reason: "Skipped: needs a card fixture",
      },
    ]);
  });

  it("passes a flaky test but keeps every attempt", () => {
    const [check] = normalizePlaywrightReport(
      report([
        {
          title: "applies a coupon",
          tests: [
            test({
              status: "flaky",
              results: [result({ status: "failed", error: { message: "expect(x).toBe(y)" } }), result({ retry: 1 })],
            }),
          ],
        },
      ]),
      CONTEXT,
    ).checks;
    expect(check?.status).toBe("passed");
    expect(check?.flaky).toBe(true);
    expect(check?.attempts.map((attempt) => attempt.status)).toEqual(["failed", "passed"]);
    expect(check?.observed).toBe("Passed on retry 1 after 1 failed attempt(s)");
  });

  it("marks a failure to reach the preview as blocked rather than failed", () => {
    const check = failing("page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4173/cart");
    expect(check?.status).toBe("blocked");
    expect(check?.failure?.code).toBe("preview-unavailable");
  });

  it("keeps a failure to reach another host as a failure of the app", () => {
    const check = failing("page.goto: net::ERR_NAME_NOT_RESOLVED at https://api.wrong-host.example/");
    expect(check?.status).toBe("failed");
    expect(check?.failure?.code).toBe("error");
  });

  it("marks a browser that cannot launch as blocked", () => {
    const check = failing(
      "browserType.launch: Executable doesn't exist at /ms-playwright/chromium_headless_shell-1243/chrome-mac/headless_shell",
    );
    expect(check?.status).toBe("blocked");
    expect(check?.failure?.code).toBe("browser");
  });

  it("keeps an assertion about page text that mentions a launch failure as a failure", () => {
    const check = failing(
      'expect(locator).toBeHidden() failed\nLocator: getByText("Failed to launch")\nExpected: hidden',
    );
    expect(check?.status).toBe("failed");
    expect(check?.failure?.code).toBe("assertion");
  });

  it("explains a test.fail() test that unexpectedly passed", () => {
    const [check] = normalizePlaywrightReport(
      report([
        {
          title: "known bug",
          tests: [test({ status: "unexpected", expectedStatus: "failed", results: [result({ status: "passed" })] })],
        },
      ]),
      CONTEXT,
    ).checks;
    expect(check?.status).toBe("failed");
    expect(check?.observed).toBe("Passed, but the test is marked test.fail() and was expected to fail");
  });

  it("describes a test.fail() test that failed as expected", () => {
    const [check] = normalizePlaywrightReport(
      report([
        { title: "known bug", tests: [test({ expectedStatus: "failed", results: [result({ status: "failed" })] })] },
      ]),
      CONTEXT,
    ).checks;
    expect(check?.status).toBe("passed");
    expect(check?.expected).toBe("Test fails, as marked by test.fail()");
    expect(check?.observed).toBe("Failed as expected");
  });

  it("gives each repeat of a repeatEach test its own ID", () => {
    const repeated = report([
      { title: "adds to cart", tests: [test()] },
      { title: "adds to cart", tests: [test()] },
    ]);
    const ids = normalizePlaywrightReport(repeated, CONTEXT).checks.map((check) => check.id);
    expect(new Set(ids).size).toBe(2);
    expect(declaredTests(repeated).map((item) => item.id)).toEqual(ids);
  });

  it("records when each attachment's attempt ended", () => {
    const normalized = normalizePlaywrightReport(
      report([
        {
          title: "t",
          tests: [
            test({
              status: "unexpected",
              results: [
                result({
                  status: "failed",
                  startTime: "2026-01-01T00:00:00.000Z",
                  duration: 2500,
                  attachments: [{ name: "screenshot", contentType: "image/png", path: "/tmp/a.png" }],
                }),
              ],
            }),
          ],
        },
      ]),
      CONTEXT,
    );
    expect(normalized.attachments[0]?.capturedAt).toBe("2026-01-01T00:00:02.500Z");
  });

  it.each([
    ["timedOut", "Test timeout of 30000ms exceeded.", "failed", "timeout"],
    ["interrupted", undefined, "blocked", "interrupted"],
    ["failed", "TypeError: cannot read x", "failed", "error"],
  ])("maps a final %s result to %s", (status, message, expected, code) => {
    const [check] = normalizePlaywrightReport(
      report([
        {
          title: "t",
          tests: [
            test({ status: "unexpected", results: [result({ status, ...(message ? { error: { message } } : {}) })] }),
          ],
        },
      ]),
      CONTEXT,
    ).checks;
    expect(check?.status).toBe(expected);
    expect(check?.failure?.code).toBe(code);
  });

  it("redacts secrets from error messages", () => {
    const [check] = normalizePlaywrightReport(
      report([
        {
          title: "t",
          tests: [
            test({
              status: "unexpected",
              results: [
                result({
                  status: "failed",
                  error: { message: "expect(page).toHaveURL failed for ?token=s3cr3t-value" },
                }),
              ],
            }),
          ],
        },
      ]),
      { ...CONTEXT, secrets: ["s3cr3t-value"] },
    ).checks;
    expect(check?.observed).toContain("?token=[REDACTED]");
    expect(check?.observed).not.toContain("s3cr3t-value");
  });

  it("turns Playwright top-level errors into run errors", () => {
    const normalized = normalizePlaywrightReport(report([], [{ message: "Error: No tests found" }]), CONTEXT);
    expect(normalized.errors).toEqual([
      { category: "configuration", message: "No tests found", stage: "playwright-run", retryable: false },
    ]);
  });

  it("counts inline attachments it cannot bundle", () => {
    const normalized = normalizePlaywrightReport(
      report([
        {
          title: "t",
          tests: [
            test({ results: [result({ attachments: [{ name: "note", contentType: "text/plain", body: "aGk=" }] })] }),
          ],
        },
      ]),
      CONTEXT,
    );
    expect(normalized.attachments).toEqual([]);
    expect(normalized.skippedInlineAttachments).toBe(1);
  });
});

describe("declaredTests", () => {
  it("keeps the title path, line and declaration-time skip reason", () => {
    const listed = declaredTests(
      report([
        { title: "pays by card", tests: [test({ status: "skipped", annotations: [{ type: "skip" }], results: [] })] },
      ]),
    );
    expect(listed).toEqual([
      expect.objectContaining({ titlePath: ["pays by card"], line: 1, skipReason: "Skipped by test.skip()" }),
    ]);
  });

  it("gives a listed test the same ID as its executed result", async () => {
    const fixture = await loadFixture();
    const normalized = normalizePlaywrightReport(fixture, CONTEXT);
    expect(declaredTests(fixture).map((item) => item.id)).toEqual(normalized.checks.map((check) => check.id));
  });
});

describe("PlaywrightJsonReport", () => {
  it("rejects reporter output with an unexpected shape", () => {
    expect(() => Schema.decodeUnknownSync(PlaywrightJsonReport)({ config: {}, errors: [], suites: "nope" })).toThrow(
      /suites/,
    );
  });
});
