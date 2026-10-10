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
import type { EvidenceFile, VerificationCheck, VerificationRun } from "./schema.ts";

/** Escapes text for HTML element content and quoted attribute values. */
export const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const STYLE = `
:root { color-scheme: light dark; --bg: #fafaf9; --surface: #ffffff; --text: #1c1917; --muted: #57534e; --border: #e7e5e4;
  --pass: #15803d; --fail: #b91c1c; --block: #a16207; --code: #f5f5f4; }
@media (prefers-color-scheme: dark) { :root { --bg: #0c0a09; --surface: #1c1917; --text: #f5f5f4; --muted: #a8a29e;
  --border: #292524; --pass: #4ade80; --fail: #f87171; --block: #facc15; --code: #292524; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 40px 0 12px; } h3 { font-size: 15px; margin: 0; }
.muted { color: var(--muted); }
.counts { display: flex; gap: 12px; flex-wrap: wrap; margin: 20px 0; }
.count { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; min-width: 110px; }
.count strong { display: block; font-size: 22px; font-variant-numeric: tabular-nums; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
.status { font-weight: 600; } .passed { color: var(--pass); } .failed { color: var(--fail); } .blocked { color: var(--block); }
.check { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin: 10px 0; }
.check header { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
pre { background: var(--code); border-radius: 6px; padding: 10px 12px; overflow-x: auto; font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
code { font-size: 13px; }
.evidence { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 10px; }
.evidence img, .evidence video { max-width: 100%; width: 420px; border: 1px solid var(--border); border-radius: 6px; }
ul { padding-left: 20px; } a { color: inherit; }
`;

const evidenceHtml = (file: EvidenceFile): string => {
  const href = escapeHtml(hrefFor(file.path));
  const label = `${file.kind}, retry ${file.attempt ?? 0}`;
  if (file.kind === "screenshot")
    return `<a href="${href}"><img src="${href}" alt="Screenshot (${escapeHtml(label)})" loading="lazy"></a>`;
  if (file.kind === "video")
    return `<div><video src="${href}" controls preload="metadata"></video><br><a href="${href}">Video (${escapeHtml(label)})</a></div>`;
  if (file.kind === "trace") {
    return `<div><a href="${href}">Trace (${escapeHtml(label)})</a><br><code>npx playwright show-trace ${escapeHtml(file.path)}</code></div>`;
  }
  return `<div><a href="${href}">${escapeHtml(file.path.split("/").at(-1) ?? file.path)}</a></div>`;
};

const checkHtml = (run: VerificationRun, check: VerificationCheck): string => {
  const evidence = evidenceFor(run, check);
  const attempts =
    check.attempts.length > 1
      ? `<p class="muted">Attempts: ${check.attempts.map((attempt) => `retry ${attempt.retry} ${escapeHtml(attempt.status)}`).join(", ")}</p>`
      : "";
  const details =
    check.status === "passed" && check.source !== "agent"
      ? check.flaky
        ? `<p class="muted">${escapeHtml(check.observed)}</p>`
        : ""
      : `<p><span class="muted">Expected:</span> ${escapeHtml(check.expected)}</p><pre>${escapeHtml(check.observed)}</pre>`;
  const evidenceBlock =
    evidence.length > 0
      ? `<div class="evidence">${evidence.map(evidenceHtml).join("")}</div>`
      : check.status === "passed"
        ? ""
        : `<p class="muted">No evidence was captured for this check.</p>`;
  return `<article class="check">
<header><span class="status ${check.status}">${STATUS_LABEL[check.status]}${check.flaky ? " (flaky)" : ""}</span>
<h3>${escapeHtml(check.titlePath.join(" › "))}</h3>
<span class="muted">${escapeHtml(check.project)} · ${escapeHtml(location(check))} · ${formatDuration(check.durationMs)}</span></header>
${details}${attempts}${evidenceBlock}
</article>`;
};

/** Renders a self-contained HTML report. Evidence is linked by relative path, not embedded. */
export const renderHtml = (run: VerificationRun): string => {
  const counts = countByStatus(run);
  const runLogs = run.evidence.filter((file) => file.checkId === null);
  const notTested =
    run.notTested.length === 0
      ? `<p>${escapeHtml(coverageSummary(run))}</p>`
      : `<ul>${run.notTested
          .map(
            (item) =>
              `<li>${escapeHtml(item.title)}${item.project === null ? "" : ` <span class="muted">(${escapeHtml(item.project)})</span>`}: ${escapeHtml(item.reason)}</li>`,
          )
          .join("")}</ul>`;
  const errors =
    run.errors.length === 0
      ? ""
      : `<h2>Run errors</h2><ul>${run.errors.map((error) => `<li><strong>${escapeHtml(error.category)}</strong> during ${escapeHtml(error.stage)}: ${escapeHtml(error.message)}</li>`).join("")}</ul>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'">
<title>katalepsis: ${STATUS_LABEL[run.status]}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Verification <span class="${run.status}">${STATUS_LABEL[run.status].toLowerCase()}</span></h1>
<p class="muted">${escapeHtml(run.previewUrl)}</p>
<div class="counts">
<div class="count"><strong class="passed">${counts.passed}</strong>passed</div>
<div class="count"><strong class="failed">${counts.failed}</strong>failed</div>
<div class="count"><strong class="blocked">${counts.blocked}</strong>blocked</div>
<div class="count"><strong>${run.notTested.length}</strong>not tested</div>
</div>
<dl>
<dt>Commit</dt><dd>${run.commitSha === null ? "unknown" : `<code>${escapeHtml(run.commitSha)}</code>`}</dd>
<dt>Repository</dt><dd>${escapeHtml(run.repository ?? "unknown")}</dd>
<dt>Started</dt><dd>${escapeHtml(run.startedAt)}</dd>
<dt>Duration</dt><dd>${formatDuration(run.durationMs)}</dd>
<dt>Runner</dt><dd>katalepsis ${escapeHtml(run.runner.katalepsis)}, Playwright ${escapeHtml(run.runner.playwright ?? "unknown")}, Node ${escapeHtml(run.runner.node)}</dd>
<dt>Run ID</dt><dd><code>${escapeHtml(run.id)}</code></dd>
</dl>
<h2>Checks</h2>
${
  orderedChecks(run)
    .map((check) => checkHtml(run, check))
    .join("\n") || "<p>No checks ran.</p>"
}
<h2>Not tested</h2>
${notTested}
<h2>Limitations</h2>
<ul>${run.coverageLimitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
${errors}
<h2>Files</h2>
<p><a href="manifest.json">manifest.json</a> · <a href="report.md">report.md</a>${runLogs.map((file) => ` · <a href="${escapeHtml(hrefFor(file.path))}">${escapeHtml(file.path)}</a>`).join("")}</p>
</main>
</body>
</html>
`;
};
