import { Context, Effect, Layer } from "effect";
import { COMMIT_HEADER, commitFromHtml, parseCommitSha } from "./preview-commit.ts";
import type { PreviewCommit } from "./schema.ts";

export type ProbeResult =
  | { readonly reachable: true; readonly commit: PreviewCommit | null }
  | { readonly reachable: false; readonly reason: string };

export class PreviewProbe extends Context.Service<
  PreviewProbe,
  { readonly check: (url: string, signal: AbortSignal) => Effect.Effect<ProbeResult> }
>()("katalepsis/PreviewProbe") {}

// Dev servers such as Vite can take well over 10 seconds to answer their first request.
const PROBE_TIMEOUT_MS = 30_000;
// Gateway errors mean the preview host is up but the deployment behind it is not.
const UNAVAILABLE_STATUSES = new Set([502, 503, 504]);
// The commit meta tag belongs in <head>, so the start of the page is enough.
const MAX_HTML_BYTES = 512 * 1024;

/**
 * Reads an HTML body up to `</head>` or `limit` bytes, then stops the download. Streamed
 * pages can keep the body open long after the head arrives, so the read must not wait for the end.
 */
const readHead = async (response: Response, limit: number): Promise<string> => {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  while (size < limit && !/<\/head\s*>/i.test(text)) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value.subarray(0, limit - size), { stream: true });
    size += value.byteLength;
  }
  await reader.cancel();
  return text;
};

/** The commit the preview reports through the commit header, or else the commit meta tag in an HTML page. */
const reportedCommit = async (response: Response): Promise<PreviewCommit | null> => {
  const header = response.headers.get(COMMIT_HEADER);
  const fromHeader = header === null ? null : parseCommitSha(header);
  if (fromHeader !== null) {
    await response.body?.cancel();
    return { sha: fromHeader, source: "header" };
  }
  if (!(response.headers.get("content-type") ?? "").includes("text/html")) {
    await response.body?.cancel();
    return null;
  }
  const fromMeta = commitFromHtml(await readHead(response, MAX_HTML_BYTES));
  return fromMeta === null ? null : { sha: fromMeta, source: "meta" };
};

export const PreviewProbeLive = Layer.succeed(PreviewProbe, {
  check: (url, signal) =>
    Effect.promise(async (): Promise<ProbeResult> => {
      try {
        const response = await fetch(url, {
          redirect: "manual",
          signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
        });
        if (UNAVAILABLE_STATUSES.has(response.status)) {
          await response.body?.cancel();
          return { reachable: false, reason: `the preview answered with HTTP ${response.status}` };
        }
        // A page that fails while its start is read is still reachable; it just reports no commit.
        return { reachable: true, commit: await reportedCommit(response).catch(() => null) };
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          return { reachable: false, reason: `no response within ${PROBE_TIMEOUT_MS / 1000} seconds` };
        }
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error);
        return { reachable: false, reason: cause };
      }
    }),
});
