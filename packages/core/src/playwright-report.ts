import { createHash } from "node:crypto";
import { Schema } from "effect";
import { redact, stripAnsi } from "./sanitize.ts";
import type { Attempt, EvidenceKind, FailureCode, NotTested, RunError, VerificationCheck } from "./schema.ts";

// Only the fields katalepsis reads from Playwright's JSON reporter. Unknown fields are ignored.
const PwError = Schema.Struct({ message: Schema.optional(Schema.String) });
const PwAttachment = Schema.Struct({
  name: Schema.String,
  contentType: Schema.String,
  path: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
});
const PwResult = Schema.Struct({
  retry: Schema.Int,
  status: Schema.String,
  duration: Schema.Number,
  startTime: Schema.optional(Schema.String),
  error: Schema.optional(PwError),
  attachments: Schema.Array(PwAttachment),
});
const PwTest = Schema.Struct({
  projectName: Schema.String,
  expectedStatus: Schema.String,
  status: Schema.Literals(["expected", "unexpected", "flaky", "skipped"]),
  annotations: Schema.Array(Schema.Struct({ type: Schema.String, description: Schema.optional(Schema.String) })),
  results: Schema.Array(PwResult),
});
const PwSpec = Schema.Struct({
  title: Schema.String,
  file: Schema.String,
  line: Schema.optional(Schema.Int),
  tags: Schema.optional(Schema.Array(Schema.String)),
  tests: Schema.Array(PwTest),
});

interface PwSuite {
  readonly title: string;
  readonly specs: ReadonlyArray<typeof PwSpec.Type>;
  readonly suites?: ReadonlyArray<PwSuite> | undefined;
}
const PwSuite: Schema.Codec<PwSuite> = Schema.Struct({
  title: Schema.String,
  specs: Schema.Array(PwSpec),
  suites: Schema.optional(Schema.Array(Schema.suspend((): Schema.Codec<PwSuite> => PwSuite))),
});

export const PlaywrightJsonReport = Schema.Struct({
  config: Schema.Struct({ version: Schema.optional(Schema.String) }),
  suites: Schema.Array(PwSuite),
  errors: Schema.Array(PwError),
});
export type PlaywrightJsonReport = typeof PlaywrightJsonReport.Type;
type PwTestEntry = {
  readonly spec: typeof PwSpec.Type;
  readonly test: typeof PwTest.Type;
  readonly titlePath: ReadonlyArray<string>;
};

/** An attachment Playwright wrote to disk that still has to be copied into the bundle. */
export type PendingAttachment = {
  readonly checkId: string;
  readonly retry: number;
  readonly name: string;
  readonly contentType: string;
  readonly kind: EvidenceKind;
  readonly sourcePath: string;
  /** End of the attempt that produced it, when Playwright reported a start time. */
  readonly capturedAt: string | null;
};

export type DeclaredTest = {
  readonly id: string;
  readonly titlePath: ReadonlyArray<string>;
  readonly file: string;
  readonly line: number | null;
  readonly project: string;
  /** Set when the test is skipped at declaration with test.skip() or test.fixme(). */
  readonly skipReason: string | null;
};

export type NormalizeContext = {
  readonly secrets: ReadonlyArray<string>;
  /** Network errors count as an unreachable preview only when they name this origin. */
  readonly previewOrigin: string;
  /**
   * Set when the run was cancelled or timed out and Playwright wrote a partial report.
   * Tests it never started, or stopped part way, are then listed as not tested for this reason.
   */
  readonly stoppedReason?: string;
};

export type NormalizedReport = {
  readonly checks: ReadonlyArray<Omit<VerificationCheck, "evidence">>;
  readonly attachments: ReadonlyArray<PendingAttachment>;
  readonly notTested: ReadonlyArray<NotTested>;
  readonly errors: ReadonlyArray<RunError>;
  readonly skippedInlineAttachments: number;
};

// Chromium, Firefox and WebKit errors for a host that could not be reached.
const UNREACHABLE_PATTERN =
  /net::ERR_(CONNECTION_REFUSED|NAME_NOT_RESOLVED|CONNECTION_RESET|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|CONNECTION_TIMED_OUT|CONNECTION_CLOSED)|NS_ERROR_(CONNECTION_REFUSED|UNKNOWN_HOST|NET_RESET)|Could not connect to (the )?server/;
// Playwright's own launch errors. Assertion messages are excluded so page text cannot match.
const BROWSER_LAUNCH_PATTERN = /^browserType\.(launch|launchPersistentContext|connect):|Executable doesn't exist at /;

const MAX_MESSAGE_LENGTH = 2000;

type IdentifiedEntry = PwTestEntry & { readonly id: string };

const flattenSuites = (
  suites: ReadonlyArray<PwSuite>,
  parents: ReadonlyArray<string>,
  depth: number,
): Array<PwTestEntry> =>
  suites.flatMap((suite) => {
    // The top-level suite is the file itself; its title duplicates `spec.file`.
    const path = depth === 0 ? parents : [...parents, suite.title];
    const own = suite.specs.flatMap((spec) =>
      spec.tests.map((test) => ({ spec, test, titlePath: [...path, spec.title] })),
    );
    return [...own, ...flattenSuites(suite.suites ?? [], path, depth + 1)];
  });

/** Derives a stable check ID from the project, file, title path and repeat occurrence. */
export const checkIdFor = (project: string, file: string, titlePath: ReadonlyArray<string>, occurrence = 0): string =>
  createHash("sha256")
    .update([project, file, ...titlePath, ...(occurrence === 0 ? [] : [String(occurrence)])].join("\u0000"))
    .digest("hex")
    .slice(0, 12);

/**
 * Flattens the report and assigns IDs. With `repeatEach`, Playwright reports the same test
 * several times in a fixed order, so each repeat gets its occurrence number in the ID.
 */
const identifiedEntries = (report: PlaywrightJsonReport): Array<IdentifiedEntry> => {
  const seen = new Map<string, number>();
  return flattenSuites(report.suites, [], 0).map((entry) => {
    const key = [entry.test.projectName, entry.spec.file, ...entry.titlePath].join("\u0000");
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    return { ...entry, id: checkIdFor(entry.test.projectName, entry.spec.file, entry.titlePath, occurrence) };
  });
};

const evidenceKind = (name: string, contentType: string): EvidenceKind => {
  if (contentType.startsWith("image/")) return "screenshot";
  if (contentType.startsWith("video/")) return "video";
  if (name === "trace") return "trace";
  return "log";
};

const cleanMessage = (message: string | undefined, secrets: ReadonlyArray<string>): string | null => {
  if (message === undefined) return null;
  const text = redact(stripAnsi(message), secrets)
    .replace(/^Error: /, "")
    .trim();
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text;
};

const classifyFailure = (
  status: string,
  message: string | null,
  previewOrigin: string,
): { status: "failed" | "blocked"; code: FailureCode } => {
  if (status === "interrupted") return { status: "blocked", code: "interrupted" };
  if (message !== null && BROWSER_LAUNCH_PATTERN.test(message) && !/\bexpect\(/.test(message)) {
    return { status: "blocked", code: "browser" };
  }
  // A dead third-party or API host is a real failure of the app, so only the preview's own origin blocks.
  if (message !== null && UNREACHABLE_PATTERN.test(message) && message.includes(previewOrigin)) {
    return { status: "blocked", code: "preview-unavailable" };
  }
  if (status === "timedOut") return { status: "failed", code: "timeout" };
  if (message !== null && /\bexpect\(/.test(message)) return { status: "failed", code: "assertion" };
  return { status: "failed", code: "error" };
};

const toCheck = (entry: IdentifiedEntry, context: NormalizeContext): Omit<VerificationCheck, "evidence"> => {
  const { spec, test } = entry;
  const attempts: Array<Attempt> = test.results.map((result) => ({
    retry: result.retry,
    status: result.status,
    durationMs: result.duration,
    startedAt: result.startTime ?? null,
    error: cleanMessage(result.error?.message, context.secrets),
  }));
  const last = attempts.at(-1);
  const expectsFailure = test.expectedStatus === "failed";
  const base = {
    id: entry.id,
    source: "playwright-test" as const,
    title: spec.title,
    titlePath: entry.titlePath,
    file: spec.file,
    line: spec.line ?? null,
    project: test.projectName,
    tags: spec.tags ?? [],
    expected: expectsFailure ? "Test fails, as marked by test.fail()" : "Test passes",
    durationMs: attempts.reduce((total, attempt) => total + attempt.durationMs, 0),
    flaky: test.status === "flaky",
    attempts,
  };

  if (test.status === "expected" || test.status === "flaky") {
    const observed =
      test.status === "flaky"
        ? `Passed on retry ${last?.retry ?? 0} after ${attempts.length - 1} failed attempt(s)`
        : expectsFailure
          ? "Failed as expected"
          : "Passed";
    return { ...base, status: "passed", observed, failure: null };
  }
  const message = last?.error ?? null;
  const { status, code } = classifyFailure(last?.status ?? "unknown", message, context.previewOrigin);
  const observed =
    message ??
    (expectsFailure && last?.status === "passed"
      ? "Passed, but the test is marked test.fail() and was expected to fail"
      : `Playwright reported status "${last?.status ?? "unknown"}" without an error message`);
  return { ...base, status, observed, failure: { code, message: observed } };
};

const skipReasonOf = (test: typeof PwTest.Type): string | null => {
  const annotation = test.annotations.find((item) => item.type === "skip" || item.type === "fixme");
  if (annotation === undefined) return null;
  return annotation.description ? `Skipped: ${annotation.description}` : `Skipped by test.${annotation.type}()`;
};

const attemptEnd = (result: typeof PwResult.Type): string | null => {
  if (result.startTime === undefined) return null;
  const start = Date.parse(result.startTime);
  return Number.isNaN(start) ? null : new Date(start + result.duration).toISOString();
};

/**
 * Converts a Playwright JSON report into checks. Playwright's outcome is authoritative:
 * an unexpected result is never reported as passed, and a skipped test is listed as not
 * tested instead of disappearing.
 */
export const normalizePlaywrightReport = (
  report: PlaywrightJsonReport,
  context: NormalizeContext,
): NormalizedReport => {
  const checks: Array<Omit<VerificationCheck, "evidence">> = [];
  const attachments: Array<PendingAttachment> = [];
  const notTested: Array<NotTested> = [];
  let skippedInlineAttachments = 0;

  for (const entry of identifiedEntries(report)) {
    if (entry.test.status === "skipped") {
      notTested.push({
        title: entry.titlePath.join(" › "),
        file: entry.spec.file,
        project: entry.test.projectName,
        reason:
          skipReasonOf(entry.test) ??
          (context.stoppedReason !== undefined && (entry.test.results.at(-1)?.status ?? "interrupted") === "interrupted"
            ? context.stoppedReason
            : "Skipped by Playwright"),
      });
      continue;
    }
    const check = toCheck(entry, context);
    checks.push(check);
    for (const result of entry.test.results) {
      for (const attachment of result.attachments) {
        if (attachment.path === undefined) {
          skippedInlineAttachments += 1;
          continue;
        }
        attachments.push({
          checkId: check.id,
          retry: result.retry,
          name: attachment.name,
          contentType: attachment.contentType,
          kind: evidenceKind(attachment.name, attachment.contentType),
          sourcePath: attachment.path,
          capturedAt: attemptEnd(result),
        });
      }
    }
  }

  const errors: Array<RunError> = report.errors.map((error) => ({
    category: "configuration",
    message: cleanMessage(error.message, context.secrets) ?? "Playwright reported an error without a message",
    stage: "playwright-run",
    retryable: false,
  }));

  return { checks, attachments, notTested, errors, skippedInlineAttachments };
};

/** Lists every test in a `playwright test --list` JSON report. */
export const declaredTests = (report: PlaywrightJsonReport): ReadonlyArray<DeclaredTest> =>
  identifiedEntries(report).map((entry) => ({
    id: entry.id,
    titlePath: entry.titlePath,
    file: entry.spec.file,
    line: entry.spec.line ?? null,
    project: entry.test.projectName,
    skipReason: skipReasonOf(entry.test),
  }));
