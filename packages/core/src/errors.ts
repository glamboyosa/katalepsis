import { Data } from "effect";

/** The run cannot start: bad input or a project without Playwright. No bundle is written. */
export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{ readonly message: string }> {}

/** The Playwright process could not be started, crashed or exceeded its time budget. */
export class PlaywrightProcessError extends Data.TaggedError("PlaywrightProcessError")<{
  readonly message: string;
  readonly retryable: boolean;
  /** Playwright's combined stdout and stderr up to the failure. */
  readonly output: string;
}> {}

/** Playwright finished but its JSON report is missing or does not match the expected shape. */
export class ReporterOutputError extends Data.TaggedError("ReporterOutputError")<{
  readonly message: string;
  readonly output: string;
}> {}

/** The report bundle could not be written. This is distinct from a failed verification. */
export class ReportWriteError extends Data.TaggedError("ReportWriteError")<{ readonly message: string }> {}
