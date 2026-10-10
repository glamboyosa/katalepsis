import { forceStopPlaywright } from "@katalepsis/core";

/**
 * Turns the first Ctrl-C, SIGTERM or SIGHUP into a cancellation, so Playwright and its browsers are
 * stopped and a blocked report is still written. A second signal exits at once.
 */
export const cancelOnSignal = (): { signal: AbortSignal; dispose: () => void } => {
  const controller = new AbortController();
  const onSignal = (name: NodeJS.Signals) => {
    if (controller.signal.aborted) {
      forceStopPlaywright();
      process.exit(130);
    }
    console.error(
      `katalepsis: received ${name}, stopping the browser and writing the report. Press Ctrl-C again to quit now.`,
    );
    controller.abort();
  };
  // Playwright runs in its own process group, so a closed terminal (SIGHUP) no longer reaches it.
  const signals: ReadonlyArray<NodeJS.Signals> = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const name of signals) process.on(name, onSignal);
  return {
    signal: controller.signal,
    dispose: () => {
      for (const name of signals) process.off(name, onSignal);
    },
  };
};
