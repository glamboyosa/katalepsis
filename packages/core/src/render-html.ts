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
import type { CheckStatus, EvidenceFile, VerificationCheck, VerificationRun } from "./schema.ts";

/** Escapes text for HTML element content and quoted attribute values. */
export const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// The report must open from a zip with no network and no scripts (see the CSP below), so it
// uses system fonts, inline SVG icons and native <details> for expanding checks.
const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #fafafa; --surface: #ffffff; --subtle: #f4f4f5; --text: #0a0a0a; --muted: #71717a; --faint: #a1a1aa;
  --border: #e4e4e7; --ring: #d4d4d8;
  --pass: #16a34a; --pass-bg: #f0fdf4; --fail: #dc2626; --fail-bg: #fef2f2; --block: #d97706; --block-bg: #fffbeb;
  --skip: #a1a1aa; --skip-bg: #f4f4f5;
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --sans: "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "Geist Mono", ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #09090b; --surface: #0f0f11; --subtle: #18181b; --text: #fafafa; --muted: #a1a1aa; --faint: #71717a;
    --border: #27272a; --ring: #3f3f46;
    --pass: #22c55e; --pass-bg: rgba(34, 197, 94, 0.1); --fail: #f87171; --fail-bg: rgba(248, 113, 113, 0.1);
    --block: #fbbf24; --block-bg: rgba(251, 191, 36, 0.1); --skip: #71717a; --skip-bg: #18181b;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.55 var(--sans);
  -webkit-font-smoothing: antialiased; font-feature-settings: "ss01", "cv11"; }
main { max-width: 1040px; margin: 0 auto; padding: 0 20px 80px; }
a { color: inherit; text-underline-offset: 3px; text-decoration-color: var(--ring); }
a:hover { text-decoration-color: currentColor; }
code, pre, .mono { font-family: var(--mono); font-size: 12.5px; }
.muted { color: var(--muted); }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 0;
  border-bottom: 1px solid var(--border); margin-bottom: 36px; }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 600; letter-spacing: -0.01em; }
.brand svg { width: 18px; height: 18px; }
.topbar .mono { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pill { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 999px;
  font-size: 12px; font-weight: 500; border: 1px solid transparent; white-space: nowrap; }
.pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.pill.passed { color: var(--pass); background: var(--pass-bg); }
.pill.failed { color: var(--fail); background: var(--fail-bg); }
.pill.blocked { color: var(--block); background: var(--block-bg); }
.hero h1 { font-size: 30px; line-height: 1.15; letter-spacing: -0.03em; font-weight: 600; margin: 14px 0 6px; }
.hero .url { font-family: var(--mono); font-size: 13px; color: var(--muted); overflow-wrap: anywhere; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }
.summary { margin: 28px 0 16px; overflow: hidden; }
.stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.stat { padding: 18px 20px; }
.stat + .stat { border-left: 1px solid var(--border); }
.stat .label { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; }
.stat .label i { width: 8px; height: 8px; border-radius: 2px; }
.stat .value { display: block; font-size: 28px; font-weight: 600; letter-spacing: -0.02em; margin-top: 2px;
  font-variant-numeric: tabular-nums; }
.bar { display: flex; height: 6px; gap: 3px; margin: 2px 20px 20px; }
.bar span { border-radius: 999px; min-width: 6px; }
.passed-bg { background: var(--pass); } .failed-bg { background: var(--fail); }
.blocked-bg { background: var(--block); } .skipped-bg { background: var(--skip); }
.meta { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin-bottom: 40px; }
.meta div { padding: 14px 20px; border-top: 1px solid var(--border); min-width: 0; }
.meta div:nth-child(-n+3) { border-top: 0; }
.meta div:not(:nth-child(3n+1)) { border-left: 1px solid var(--border); }
.meta dt { color: var(--muted); font-size: 12px; margin-bottom: 2px; }
.meta dd { margin: 0; overflow-wrap: anywhere; }
section { margin-top: 40px; }
section > h2 { display: flex; align-items: baseline; gap: 8px; font-size: 16px; font-weight: 600;
  letter-spacing: -0.01em; margin: 0 0 12px; }
section > h2 .count { color: var(--muted); font-weight: 400; font-size: 14px; }
.list { overflow: hidden; }
.check + .check { border-top: 1px solid var(--border); }
.check > summary { list-style: none; display: grid; grid-template-columns: 20px minmax(0, 1fr) auto;
  align-items: center; gap: 12px; padding: 14px 18px; cursor: pointer; }
.check > summary::-webkit-details-marker { display: none; }
.check > summary:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
@media (hover: hover) and (pointer: fine) { .check > summary { transition: background-color 150ms ease; }
  .check > summary:hover { background: var(--subtle); } }
.icon { width: 20px; height: 20px; }
.icon.passed { color: var(--pass); } .icon.failed { color: var(--fail); } .icon.blocked { color: var(--block); }
.title { min-width: 0; }
.title strong { font-weight: 500; display: block; overflow-wrap: anywhere; }
.title .path { display: block; color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.aside { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 12.5px; }
.chip { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border: 1px solid var(--border);
  border-radius: 6px; background: var(--subtle); color: var(--muted); font-size: 12px; white-space: nowrap; }
.chip.warn { color: var(--block); border-color: transparent; background: var(--block-bg); }
.duration { font-family: var(--mono); font-variant-numeric: tabular-nums; min-width: 56px; text-align: right; }
.chevron { width: 16px; height: 16px; color: var(--faint); transition: transform 200ms var(--ease-out); }
.check[open] .chevron { transform: rotate(90deg); }
.body { padding: 2px 18px 18px 50px; }
.body .row { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 12px; margin: 10px 0; }
.body .row > span:first-child { color: var(--muted); font-size: 12.5px; padding-top: 1px; }
pre { margin: 0; background: var(--subtle); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px;
  overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
.attempts { display: flex; flex-wrap: wrap; gap: 6px; }
.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin-top: 14px; }
.shot { display: block; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--subtle);
  text-decoration: none; }
.shot img, .shot video { display: block; width: 100%; height: auto; }
.shot figcaption { padding: 8px 10px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--border);
  background: var(--surface); }
.files { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
.file { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 12px;
  border: 1px solid var(--border); border-radius: 8px; }
.file code { color: var(--muted); }
.empty { color: var(--muted); padding: 18px 20px; }
.items { list-style: none; margin: 0; padding: 0; }
.items li { padding: 12px 20px; display: grid; gap: 2px; }
.items li + li { border-top: 1px solid var(--border); }
.items .reason { color: var(--muted); font-size: 13px; }
.callout { border-color: color-mix(in srgb, var(--fail) 35%, var(--border)); background: var(--fail-bg); }
.callout li { color: var(--text); }
footer { margin-top: 48px; padding-top: 18px; border-top: 1px solid var(--border); display: flex; flex-wrap: wrap;
  gap: 8px 18px; color: var(--muted); font-size: 13px; }
@media (max-width: 720px) {
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stat:nth-child(3) { border-left: 0; }
  .stat:nth-child(n+3) { border-top: 1px solid var(--border); }
  .meta { grid-template-columns: minmax(0, 1fr); }
  .meta div { border-left: 0 !important; border-top: 1px solid var(--border) !important; }
  .meta div:first-child { border-top: 0 !important; }
  .check > summary { grid-template-columns: 20px minmax(0, 1fr); }
  .aside { grid-column: 2; flex-wrap: wrap; min-width: 0; }
  .aside .chip { display: inline-block; line-height: 20px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .body { padding-left: 18px; }
  .body .row { grid-template-columns: minmax(0, 1fr); gap: 4px; }
}
@media (prefers-reduced-motion: reduce) { .chevron { transition: none; } }
`;

const ICON_PATH: Record<CheckStatus, string> = {
  passed: '<circle cx="10" cy="10" r="8"/><path d="m6.5 10.2 2.3 2.3 4.7-4.9"/>',
  failed: '<circle cx="10" cy="10" r="8"/><path d="m7.4 7.4 5.2 5.2m0-5.2-5.2 5.2"/>',
  blocked: '<circle cx="10" cy="10" r="8"/><path d="M10 6.2v4.6m0 2.9v.1"/>',
};

const statusIcon = (status: CheckStatus): string =>
  `<svg class="icon ${status}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATH[status]}</svg>`;

const CHEVRON = `<svg class="chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>`;

const MARK = `<svg viewBox="0 0 18 18" aria-hidden="true"><rect x="1" y="1" width="16" height="16" rx="4" fill="currentColor"/><path d="m5.5 9.2 2.2 2.2 4.8-5" fill="none" stroke="var(--bg)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const evidenceHtml = (file: EvidenceFile): string => {
  const href = escapeHtml(hrefFor(file.path));
  // Agent checks save one screenshot per assertion, named after its ID, such as retry-0-a2-screenshot.png.
  const assertion = /-(a\d+)-screenshot\.png$/.exec(file.path)?.[1];
  const label = escapeHtml(
    assertion === undefined ? `${file.kind} · attempt ${(file.attempt ?? 0) + 1}` : `assertion ${assertion}`,
  );
  if (file.kind === "screenshot") {
    return `<a class="shot" href="${href}"><figure style="margin:0"><img src="${href}" alt="Screenshot, ${label}" loading="lazy"><figcaption>${label}</figcaption></figure></a>`;
  }
  if (file.kind === "video") {
    return `<figure class="shot" style="margin:0"><video src="${href}" controls preload="metadata"></video><figcaption><a href="${href}">${label}</a></figcaption></figure>`;
  }
  return "";
};

const fileHtml = (file: EvidenceFile): string => {
  const href = escapeHtml(hrefFor(file.path));
  const name = escapeHtml(file.path.split("/").at(-1) ?? file.path);
  if (file.kind === "trace") {
    return `<div class="file"><a href="${href}">${name}</a><code>npx playwright show-trace ${escapeHtml(file.path)}</code></div>`;
  }
  return `<div class="file"><a href="${href}">${name}</a><span class="chip">${escapeHtml(file.kind)}</span></div>`;
};

const checkHtml = (run: VerificationRun, check: VerificationCheck): string => {
  const evidence = evidenceFor(run, check);
  const media = evidence.filter((file) => file.kind === "screenshot" || file.kind === "video");
  const others = evidence.filter((file) => file.kind !== "screenshot" && file.kind !== "video");
  const name = check.titlePath.at(-1) ?? check.title;
  const parents = check.titlePath.slice(0, -1).join(" › ");
  const showResult = check.status !== "passed" || check.source === "agent" || check.flaky;
  const rows = [
    showResult ? `<div class="row"><span>Expected</span><span>${escapeHtml(check.expected)}</span></div>` : "",
    showResult ? `<div class="row"><span>Observed</span><pre>${escapeHtml(check.observed)}</pre></div>` : "",
    check.attempts.length > 1
      ? `<div class="row"><span>Attempts</span><span class="attempts">${check.attempts
          .map((attempt) => `<span class="chip">#${attempt.retry + 1} ${escapeHtml(attempt.status)}</span>`)
          .join("")}</span></div>`
      : "",
    `<div class="row"><span>Location</span><span class="mono">${escapeHtml(location(check))}</span></div>`,
  ].join("");
  const evidenceBlock =
    evidence.length === 0
      ? check.status === "passed"
        ? ""
        : `<p class="muted">No evidence was captured for this check.</p>`
      : `${media.length > 0 ? `<div class="gallery">${media.map(evidenceHtml).join("")}</div>` : ""}${
          others.length > 0 ? `<div class="files">${others.map(fileHtml).join("")}</div>` : ""
        }`;
  return `<details class="check"${check.status === "passed" ? "" : " open"}>
<summary>${statusIcon(check.status)}<span class="title"><span class="sr-only">${STATUS_LABEL[check.status]}: </span><strong>${escapeHtml(name)}</strong>${
    parents === "" ? "" : `<span class="path">${escapeHtml(parents)}</span>`
  }</span><span class="aside">${check.flaky ? '<span class="chip warn">flaky</span>' : ""}<span class="chip">${escapeHtml(
    check.project,
  )}</span><span class="duration">${formatDuration(check.durationMs)}</span>${CHEVRON}</span></summary>
<div class="body">${rows}${evidenceBlock}</div>
</details>`;
};

const barHtml = (counts: Record<CheckStatus, number>, notTested: number): string => {
  const parts: Array<[string, number]> = [
    ["passed-bg", counts.passed],
    ["failed-bg", counts.failed],
    ["blocked-bg", counts.blocked],
    ["skipped-bg", notTested],
  ];
  return `<div class="bar" aria-hidden="true">${parts
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `<span class="${kind}" style="flex:${count}"></span>`)
    .join("")}</div>`;
};

const stat = (label: string, swatch: string, value: number): string =>
  `<div class="stat"><span class="label"><i class="${swatch}"></i>${label}</span><span class="value">${value}</span></div>`;

const metaItem = (label: string, value: string): string => `<div><dt>${label}</dt><dd>${value}</dd></div>`;

/** Renders a self-contained HTML report. Evidence is linked by relative path, not embedded. */
export const renderHtml = (run: VerificationRun): string => {
  const counts = countByStatus(run);
  const runLogs = run.evidence.filter((file) => file.checkId === null);
  const notTested =
    run.notTested.length === 0
      ? `<p class="empty">${escapeHtml(coverageSummary(run))}</p>`
      : `<ul class="items">${run.notTested
          .map(
            (item) =>
              `<li><span>${escapeHtml(item.title)}${item.project === null ? "" : ` <span class="chip">${escapeHtml(item.project)}</span>`}</span><span class="reason">${escapeHtml(item.reason)}</span></li>`,
          )
          .join("")}</ul>`;
  const errors =
    run.errors.length === 0
      ? ""
      : `<section><h2>Run errors <span class="count">${run.errors.length}</span></h2><div class="card callout"><ul class="items">${run.errors
          .map(
            (error) =>
              `<li><span><strong>${escapeHtml(error.category)}</strong> <span class="muted">during ${escapeHtml(error.stage)}</span></span><pre>${escapeHtml(error.message)}</pre></li>`,
          )
          .join("")}</ul></div></section>`;
  const checks = orderedChecks(run);

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
<header class="topbar"><span class="brand">${MARK}katalepsis</span><span class="mono">${escapeHtml(run.id)}</span></header>
<div class="hero">
<span class="pill ${run.status}">${STATUS_LABEL[run.status]}</span>
<h1>${counts.passed} of ${run.checks.length} ${run.checks.length === 1 ? "check" : "checks"} passed</h1>
<div class="url">${escapeHtml(run.previewUrl)}</div>
</div>
<div class="card summary">
<div class="stats">${stat("Passed", "passed-bg", counts.passed)}${stat("Failed", "failed-bg", counts.failed)}${stat(
    "Blocked",
    "blocked-bg",
    counts.blocked,
  )}${stat("Not tested", "skipped-bg", run.notTested.length)}</div>
${barHtml(counts, run.notTested.length)}
</div>
<dl class="card meta">
${metaItem("Commit", run.commitSha === null ? "unknown" : `<code title="${escapeHtml(run.commitSha)}">${escapeHtml(run.commitSha.slice(0, 12))}</code>`)}
${metaItem("Repository", escapeHtml(run.repository ?? "unknown"))}
${metaItem("Duration", formatDuration(run.durationMs))}
${metaItem("Started", escapeHtml(run.startedAt))}
${metaItem("Model", run.model === null ? "None" : escapeHtml(`${run.model.provider}/${run.model.id}`))}
${metaItem("Runner", `katalepsis ${escapeHtml(run.runner.katalepsis)} · Playwright ${escapeHtml(run.runner.playwright ?? "unknown")} · Node ${escapeHtml(run.runner.node)}`)}
</dl>
<section><h2>Checks <span class="count">${checks.length}</span></h2>
${checks.length === 0 ? '<div class="card"><p class="empty">No checks ran.</p></div>' : `<div class="card list">${checks.map((check) => checkHtml(run, check)).join("\n")}</div>`}
</section>
<section><h2>Not tested <span class="count">${run.notTested.length}</span></h2><div class="card">${notTested}</div></section>
${errors}
<section><h2>Limitations</h2><div class="card"><ul class="items">${run.coverageLimitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div></section>
<footer><a href="manifest.json">manifest.json</a><a href="report.md">report.md</a>${runLogs
    .map((file) => `<a href="${escapeHtml(hrefFor(file.path))}">${escapeHtml(file.path)}</a>`)
    .join("")}<span>${escapeHtml(run.environment)}</span></footer>
</main>
</body>
</html>
`;
};
