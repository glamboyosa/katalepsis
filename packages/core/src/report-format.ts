import type { CheckStatus, EvidenceFile, VerificationCheck, VerificationRun } from "./schema.ts";

export const STATUS_LABEL: Record<CheckStatus, string> = { passed: "Passed", failed: "Failed", blocked: "Blocked" };

export const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
};

export const countByStatus = (run: VerificationRun): Record<CheckStatus, number> => ({
  passed: run.checks.filter((check) => check.status === "passed").length,
  failed: run.checks.filter((check) => check.status === "failed").length,
  blocked: run.checks.filter((check) => check.status === "blocked").length,
});

/** The sentence shown when no declared test is listed as not tested. */
export const coverageSummary = (run: VerificationRun): string => {
  if (run.errors.some((error) => error.stage === "playwright-list")) {
    return "Playwright could not list the declared tests, so what was not tested is unknown.";
  }
  if (run.declaredTests === 0) return "Playwright found no tests.";
  if (run.checks.every((check) => check.attempts.length === 0)) {
    return "Playwright was not run, so no declared test ran.";
  }
  return run.checks.length >= run.declaredTests ? "Every declared test ran." : "Some declared tests did not run.";
};

export const evidenceFor = (run: VerificationRun, check: VerificationCheck): ReadonlyArray<EvidenceFile> =>
  run.evidence.filter((file) => file.checkId === check.id);

/** Failed and blocked checks first, so a reviewer sees problems before passes. */
export const orderedChecks = (run: VerificationRun): ReadonlyArray<VerificationCheck> => {
  const rank: Record<CheckStatus, number> = { failed: 0, blocked: 1, passed: 2 };
  return run.checks.toSorted((a, b) => rank[a.status] - rank[b.status]);
};

export const location = (check: VerificationCheck): string =>
  check.line === null ? check.file : `${check.file}:${check.line}`;

/** Encodes each segment of a bundle path for use in a link. */
export const hrefFor = (bundlePath: string): string => bundlePath.split("/").map(encodeURIComponent).join("/");
