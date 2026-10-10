import { describe, expect, it } from "vitest";
import { InvalidPreviewUrl, parsePreviewUrl, previewUrlSecrets, redact, stripAnsi } from "../src/index.ts";

describe("parsePreviewUrl", () => {
  it("redacts query values in the persisted form but keeps them for Playwright", () => {
    const preview = parsePreviewUrl("https://preview.example.com/app?x-bypass=tok3n-value&lang=en#top");
    expect(preview.display).toBe("https://preview.example.com/app?x-bypass=REDACTED&lang=REDACTED");
    expect(preview.raw).toContain("tok3n-value");
    expect(previewUrlSecrets(preview)).toEqual(["tok3n-value", "en"]);
  });

  it.each([
    ["ftp://example.com", /http or https/],
    ["https://user:pass@example.com", /username or password/],
    ["not a url", /not a valid absolute URL/],
  ])("rejects %s", (input, message) => {
    expect(() => parsePreviewUrl(input)).toThrow(InvalidPreviewUrl);
    expect(() => parsePreviewUrl(input)).toThrow(message);
  });

  it("allows localhost because the CLI runs on the developer's machine", () => {
    expect(parsePreviewUrl("http://localhost:4173").origin).toBe("http://localhost:4173");
  });
});

describe("redact", () => {
  it("redacts a token with + exactly as it appears in the URL", () => {
    const preview = parsePreviewUrl("https://preview.example.com/?token=abc+def123");
    expect(redact("GET https://preview.example.com/?token=abc+def123", previewUrlSecrets(preview))).toBe(
      "GET https://preview.example.com/?token=[REDACTED]",
    );
  });

  it("redacts percent-escapes written in lowercase", () => {
    const preview = parsePreviewUrl("https://preview.example.com/?token=abc%2Fdef123");
    expect(redact("at https://preview.example.com/?token=abc%2fdef123", previewUrlSecrets(preview))).toBe(
      "at https://preview.example.com/?token=[REDACTED]",
    );
  });

  it("treats regular-expression characters in a secret literally", () => {
    expect(redact("a.b*c and axbyc", ["a.b*c"])).toBe("[REDACTED] and axbyc");
  });

  it("removes plain and URL-encoded secrets", () => {
    expect(redact("token=a b/c and a%20b%2Fc", ["a b/c"])).toBe("token=[REDACTED] and [REDACTED]");
  });

  it("ignores very short values that would erase ordinary text", () => {
    expect(redact("lang=en", ["en"])).toBe("lang=en");
  });
});

describe("stripAnsi", () => {
  it("removes colour codes from Playwright errors", () => {
    expect(stripAnsi("\u001b[2mexpect(\u001b[22m\u001b[31mlocator\u001b[39m")).toBe("expect(locator");
  });
});
