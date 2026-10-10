import { describe, expect, it } from "vitest";
import { renderHtml, renderMarkdown, type VerificationCheck, type VerificationRun } from "../src/index.ts";

const check = (overrides: Partial<VerificationCheck>): VerificationCheck => ({
  id: "aaaaaaaaaaaa",
  source: "playwright-test",
  title: "valid submission",
  titlePath: ["signup", "valid submission"],
  file: "signup.spec.ts",
  line: 13,
  project: "chromium",
  tags: [],
  expected: "Test passes",
  observed: "Passed",
  status: "passed",
  durationMs: 240,
  flaky: false,
  failure: null,
  attempts: [{ retry: 0, status: "passed", durationMs: 240, startedAt: null, error: null }],
  evidence: [],
  ...overrides,
});

const run: VerificationRun = {
  schemaVersion: 1,
  id: "2026-01-01T00-00-00-000Z-abcdef",
  previewUrl: "https://preview.example.com/?token=REDACTED",
  repository: null,
  commitSha: null,
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:05.000Z",
  durationMs: 5000,
  environment: "local",
  runner: { katalepsis: "0.1.0", playwright: "1.63.0", node: "22.12.0" },
  model: null,
  status: "failed",
  declaredTests: 3,
  checks: [
    check({}),
    check({
      id: "bbbbbbbbbbbb",
      title: "empty submission",
      titlePath: ["signup", "empty submission"],
      status: "failed",
      observed: 'expect(locator).toHaveText(expected) failed\nReceived: "<img src=x onerror=alert(1)>"',
      failure: { code: "assertion", message: "expect failed" },
      evidence: ["evidence/bbbbbbbbbbbb/retry-0-screenshot.png"],
    }),
  ],
  notTested: [
    {
      title: "signup › pipes | in <title>",
      file: "signup.spec.ts",
      project: "chromium",
      reason: "Excluded by the --project or --grep filter",
    },
  ],
  coverageLimitations: ["Commit is unknown: the project directory is not a git checkout with a commit."],
  evidence: [
    {
      path: "evidence/bbbbbbbbbbbb/retry-0-screenshot.png",
      mimeType: "image/png",
      kind: "screenshot",
      bytes: 10,
      sha256: "0".repeat(64),
      checkId: "bbbbbbbbbbbb",
      attempt: 0,
      capturedAt: "2026-01-01T00:00:04.000Z",
    },
  ],
  errors: [],
};

describe("renderHtml", () => {
  it("escapes text that came from the page or the tests", () => {
    const html = renderHtml(run);
    expect(html).not.toContain("<img src=x onerror");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("pipes | in &lt;title&gt;");
  });

  it("links evidence by relative path", () => {
    expect(renderHtml(run)).toContain('<img src="evidence/bbbbbbbbbbbb/retry-0-screenshot.png"');
  });

  it("is deterministic", () => {
    expect(renderHtml(run)).toMatchSnapshot();
  });
});

describe("renderMarkdown", () => {
  it("lists failures first and keeps table cells intact", () => {
    const markdown = renderMarkdown(run);
    const rows = markdown.split("\n").filter((line) => line.startsWith("| Failed") || line.startsWith("| Passed"));
    expect(rows[0]).toContain("signup › empty submission");
    expect(markdown).toContain("pipes \\| in \\<title\\>");
    expect(markdown).toContain("Commit: unknown");
    expect(markdown).toContain("[screenshot](evidence/bbbbbbbbbbbb/retry-0-screenshot.png)");
  });

  it("is deterministic", () => {
    expect(renderMarkdown(run)).toMatchSnapshot();
  });
});
