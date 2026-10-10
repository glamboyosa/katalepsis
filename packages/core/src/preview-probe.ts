import { Context, Effect, Layer } from "effect";

export type ProbeResult = { readonly reachable: true } | { readonly reachable: false; readonly reason: string };

export class PreviewProbe extends Context.Service<
  PreviewProbe,
  { readonly check: (url: string, signal: AbortSignal) => Effect.Effect<ProbeResult> }
>()("katalepsis/PreviewProbe") {}

// Dev servers such as Vite can take well over 10 seconds to answer their first request.
const PROBE_TIMEOUT_MS = 30_000;
// Gateway errors mean the preview host is up but the deployment behind it is not.
const UNAVAILABLE_STATUSES = new Set([502, 503, 504]);

export const PreviewProbeLive = Layer.succeed(PreviewProbe, {
  check: (url, signal) =>
    Effect.promise(async (): Promise<ProbeResult> => {
      try {
        const response = await fetch(url, {
          redirect: "manual",
          signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
        });
        await response.body?.cancel();
        return UNAVAILABLE_STATUSES.has(response.status)
          ? { reachable: false, reason: `the preview answered with HTTP ${response.status}` }
          : { reachable: true };
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          return { reachable: false, reason: `no response within ${PROBE_TIMEOUT_MS / 1000} seconds` };
        }
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error);
        return { reachable: false, reason: cause };
      }
    }),
});
