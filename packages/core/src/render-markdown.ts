import {
  countByStatus,
  coverageSummary,
  evidenceFor,
  formatDuration,
  hrefFor,
  location,
  orderedChecks,
  STATUS_LABEL,
} from "./report-format.ts";
import type { VerificationRun } from "./schema.ts";

/** Escapes text for a Markdown table cell or inline span. */
const md = (text: string): string =>
  text
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]<>|])/g, "\\$1")
    .replace(/\r?\n/g, " ");

const fence = (text: string): string => {
  const longestRun = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const ticks = "`".repeat(longestRun + 1);
  return `${ticks}text\n${text}\n${ticks}`;
};

/** Renders a concise Markdown summary for a PR description or comment. */
export const renderMarkdown = (run: VerificationRun): string => {
  const counts = countByStatus(run);
  const lines: Array<string> = [
    `# katalepsis report: ${STATUS_LABEL[run.status]}`,
    "",
    `**${counts.passed} passed, ${counts.failed} failed, ${counts.blocked} blocked** out of ${run.checks.length} checks run. ${run.notTested.length} declared tests were not run.`,
    "",
    `- Preview: ${md(run.previewUrl)}`,
    `- Commit: ${run.commitSha === null ? "unknown" : `\`${run.commitSha}\``}`,
    `- Started: ${run.startedAt}`,
    `- Duration: ${formatDuration(run.durationMs)}`,
    `- Runner: katalepsis ${run.runner.katalepsis}, Playwright ${run.runner.playwright ?? "unknown"}, Node ${run.runner.node}`,
    "",
    "## Checks",
    "",
    "| Status | Check | Project | Location | Duration |",
    "| --- | --- | --- | --- | --- |",
    ...orderedChecks(run).map(
      (check) =>
        `| ${STATUS_LABEL[check.status]}${check.flaky ? " (flaky)" : ""} | ${md(check.titlePath.join(" › "))} | ${md(check.project)} | ${md(location(check))} | ${formatDuration(check.durationMs)} |`,
    ),
  ];

  // Agent checks always show their evidence: a pass is only as good as the assertions it cites.
  const problems = orderedChecks(run).filter((check) => check.status !== "passed" || check.source === "agent");
  if (problems.length > 0) {
    lines.push(
      "",
      run.checks.some((check) => check.source === "agent") ? "## Check details" : "## Failures and blocked checks",
    );
    for (const check of problems) {
      lines.push("", `### ${STATUS_LABEL[check.status]}: ${md(check.titlePath.join(" › "))}`, "");
      lines.push(`- Expected: ${md(check.expected)}`, `- Location: ${md(location(check))}`);
      if (check.failure !== null) lines.push(`- Failure type: ${check.failure.code}`);
      const evidence = evidenceFor(run, check);
      if (evidence.length > 0) {
        lines.push(`- Evidence: ${evidence.map((file) => `[${file.kind}](${hrefFor(file.path)})`).join(", ")}`);
      } else {
        lines.push("- Evidence: none captured");
      }
      lines.push("", "Observed:", "", fence(check.observed));
    }
  }

  lines.push("", "## Not tested", "");
  if (run.notTested.length === 0) {
    lines.push(coverageSummary(run));
  } else {
    for (const item of run.notTested) {
      lines.push(`- ${md(item.title)}${item.project === null ? "" : ` (${md(item.project)})`}: ${md(item.reason)}`);
    }
  }

  lines.push("", "## Limitations", "");
  lines.push(...run.coverageLimitations.map((limitation) => `- ${md(limitation)}`));

  if (run.errors.length > 0) {
    lines.push("", "## Run errors", "");
    lines.push(...run.errors.map((error) => `- ${error.category} during ${error.stage}: ${md(error.message)}`));
  }

  lines.push("", `Full report: [report.html](report.html). Manifest: [manifest.json](manifest.json).`, "");
  return lines.join("\n");
};
