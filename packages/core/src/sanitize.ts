// oxlint-disable-next-line no-control-regex -- ANSI colour codes begin with the ESC control character.
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, "");

export type PreviewUrl = {
  /** The URL handed to Playwright. It may carry tokens and must not be persisted. */
  readonly raw: string;
  /** The URL safe to persist: credentials removed and query values redacted. */
  readonly display: string;
  readonly origin: string;
};

export class InvalidPreviewUrl extends Error {}

/**
 * Parses a preview URL. Only http and https are allowed. Embedded credentials are rejected
 * because the persisted report must never hold them; query values are redacted because
 * preview hosts often put bypass tokens there.
 */
export const parsePreviewUrl = (input: string): PreviewUrl => {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new InvalidPreviewUrl(`Preview URL is not a valid absolute URL: ${JSON.stringify(input.slice(0, 200))}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidPreviewUrl(`Preview URL must use http or https, got ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new InvalidPreviewUrl("Preview URL must not contain a username or password.");
  }
  const display = new URL(url.href);
  for (const key of Array.from(display.searchParams.keys())) {
    display.searchParams.set(key, "REDACTED");
  }
  display.hash = "";
  return { raw: url.href, display: display.href, origin: url.origin };
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The spellings a value can take in URLs and logs: as is, percent-encoded, and form-encoded. */
const spellings = (secret: string): ReadonlyArray<string> => {
  const encoded = encodeURIComponent(secret);
  return [...new Set([secret, encoded, encoded.replace(/%20/g, "+")])];
};

/**
 * Removes every occurrence of each secret from `text`, including its URL-encoded forms.
 * Percent-escapes match in either case. Redaction happens before anything is written to
 * the report bundle.
 */
export const redact = (text: string, secrets: ReadonlyArray<string>): string => {
  let result = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    for (const spelling of spellings(secret)) {
      const pattern = escapeRegExp(spelling).replace(
        /%[0-9A-F]{2}/g,
        (escape) => `(?:${escape}|${escape.toLowerCase()})`,
      );
      result = result.replace(new RegExp(pattern, "g"), "[REDACTED]");
    }
  }
  return result;
};

/**
 * Collects the query values of a preview URL, both decoded and exactly as written,
 * because Playwright output echoes the URL as written.
 */
export const previewUrlSecrets = (preview: PreviewUrl): ReadonlyArray<string> => {
  const url = new URL(preview.raw);
  const decoded = [...url.searchParams.values()];
  const raw = url.search
    .slice(1)
    .split("&")
    .filter((pair) => pair.includes("="))
    .map((pair) => pair.slice(pair.indexOf("=") + 1));
  return [...new Set([...decoded, ...raw])].filter((value) => value.length > 0);
};
