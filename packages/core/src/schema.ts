import { Schema } from "effect";

export const SCHEMA_VERSION = 2;

/** A POSIX path inside the report bundle. Absolute paths and `..` segments are rejected. */
export const BundlePath = Schema.String.check(
  Schema.makeFilter((path: string) => isBundlePath(path) || "must be a relative path inside the report bundle"),
);

/** Returns true when `path` is a relative POSIX path that cannot leave its base directory. */
export const isBundlePath = (path: string): boolean => {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || /^[a-zA-Z]:/.test(path)) {
    return false;
  }
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
};

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

export const CheckStatus = Schema.Literals(["passed", "failed", "blocked"]);
export type CheckStatus = typeof CheckStatus.Type;

export const EvidenceKind = Schema.Literals(["screenshot", "video", "trace", "log"]);
export type EvidenceKind = typeof EvidenceKind.Type;

export const EvidenceFile = Schema.Struct({
  path: BundlePath,
  mimeType: Schema.String,
  kind: EvidenceKind,
  bytes: NonNegativeInt,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  /** Null for run-level evidence such as the Playwright process log. */
  checkId: Schema.NullOr(Schema.String),
  /** Playwright retry index; null for run-level evidence. */
  attempt: Schema.NullOr(NonNegativeInt),
  capturedAt: Schema.String,
});
export type EvidenceFile = typeof EvidenceFile.Type;

export const FailureCode = Schema.Literals([
  "assertion",
  "no-evidence",
  "budget",
  "model",
  "navigation",
  "timeout",
  "error",
  "preview-unavailable",
  "browser",
  "interrupted",
]);
export type FailureCode = typeof FailureCode.Type;

export const Attempt = Schema.Struct({
  retry: NonNegativeInt,
  /** Raw Playwright result status, for example `passed`, `failed` or `timedOut`. */
  status: Schema.String,
  durationMs: NonNegativeNumber,
  startedAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type Attempt = typeof Attempt.Type;

export const VerificationCheck = Schema.Struct({
  id: Schema.String,
  source: Schema.Literals(["playwright-test", "agent"]),
  title: Schema.String,
  titlePath: Schema.Array(Schema.String),
  file: Schema.String,
  line: Schema.NullOr(NonNegativeInt),
  project: Schema.String,
  tags: Schema.Array(Schema.String),
  expected: Schema.String,
  observed: Schema.String,
  status: CheckStatus,
  durationMs: NonNegativeNumber,
  flaky: Schema.Boolean,
  failure: Schema.NullOr(Schema.Struct({ code: FailureCode, message: Schema.String })),
  attempts: Schema.Array(Attempt),
  evidence: Schema.Array(BundlePath),
});
export type VerificationCheck = typeof VerificationCheck.Type;

export const NotTested = Schema.Struct({
  title: Schema.String,
  file: Schema.NullOr(Schema.String),
  project: Schema.NullOr(Schema.String),
  reason: Schema.String,
});
export type NotTested = typeof NotTested.Type;

export const RunErrorCategory = Schema.Literals([
  "configuration",
  "credentials",
  "browser",
  "preview-unavailable",
  "assertion",
  "budget",
  "infrastructure",
  "commit-mismatch",
  "unknown",
]);
export type RunErrorCategory = typeof RunErrorCategory.Type;

export const RunError = Schema.Struct({
  category: RunErrorCategory,
  message: Schema.String,
  stage: Schema.String,
  retryable: Schema.Boolean,
});
export type RunError = typeof RunError.Type;

export const PreviewCommit = Schema.Struct({
  sha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{7,40}$/)),
  /** Where the commit came from: the caller, a response header, or a meta tag in the page. */
  source: Schema.Literals(["option", "header", "meta"]),
});
export type PreviewCommit = typeof PreviewCommit.Type;

/** Whether the preview reported the checkout's commit. Unknown when either side is missing. */
export const CommitAlignment = Schema.Literals(["confirmed", "mismatched", "unknown"]);
export type CommitAlignment = typeof CommitAlignment.Type;

export const VerificationRun = Schema.Struct({
  schemaVersion: Schema.Literal(SCHEMA_VERSION),
  id: Schema.String,
  previewUrl: Schema.String,
  repository: Schema.NullOr(Schema.String),
  /** Commit of the local checkout. Null when it cannot be read; never guessed. */
  commitSha: Schema.NullOr(Schema.String),
  /** Commit the preview reported it was built from. Null when it reported none. */
  previewCommit: Schema.NullOr(PreviewCommit),
  commitAlignment: CommitAlignment,
  startedAt: Schema.String,
  finishedAt: Schema.String,
  durationMs: NonNegativeNumber,
  environment: Schema.String,
  runner: Schema.Struct({
    katalepsis: Schema.String,
    playwright: Schema.NullOr(Schema.String),
    node: Schema.String,
  }),
  model: Schema.NullOr(Schema.Struct({ provider: Schema.String, id: Schema.String })),
  status: CheckStatus,
  declaredTests: NonNegativeInt,
  checks: Schema.Array(VerificationCheck),
  notTested: Schema.Array(NotTested),
  coverageLimitations: Schema.Array(Schema.String),
  evidence: Schema.Array(EvidenceFile),
  errors: Schema.Array(RunError),
});
export type VerificationRun = typeof VerificationRun.Type;
