# ADR 0004: Preview commit alignment

- Status: accepted
- Date: 2026-10-12

## Context

The report recorded `HEAD` of the local checkout and said katalepsis could not confirm the preview was built from it. Previews often lag behind a branch, so a green run against an older deployment could be read as evidence about the current diff.

## Decisions

1. **Three sources, first match wins.** An `x-commit-sha` header on the preview URL, then `<meta name="commit-sha" content="…">` in the HTML up to `</head>` or 512 KB, then the commit the caller passes (`--preview-commit` on `run` and `verify`, `previewCommit` over MCP). What the preview serves outranks what the caller expects: CI that passes the pushed commit would otherwise confirm a stale preview. The preview probe already requests the URL, so detection adds no request. Values must be 7 to 40 hex characters; anything else counts as not reported. A bad value passed by the caller is a usage error.
2. **No host-specific detection.** Vercel, Netlify and Cloudflare Pages expose the commit to the build, not in response headers, so katalepsis documents how to render the meta tag instead of guessing from host headers.
3. **Three results.** `confirmed` when the preview commit is a prefix of the checkout `HEAD`, `mismatched` when it is not, and `unknown` when either side is missing. The manifest stores `previewCommit` (`sha` and `source`) and `commitAlignment`, so `schemaVersion` is now 2.
4. **A mismatch blocks a pass but not a failure.** A mismatch adds a `commit-mismatch` run error, and `aggregateStatus` already turns any run error into blocked unless a check failed. A pass against other code says nothing about the checkout, so it must not exit 0. A failure is real for the code that is deployed, so it stays failed and visible.
5. **Checks still run on a mismatch.** Skipping them would hide what the deployed code does, and the mismatch may be expected while a deployment is catching up. The error message says to wait for the new preview and run again.
6. **Unknown changes nothing.** Most previews will not report a commit until the app or CI is set up, and blocking every such run would make katalepsis unusable by default. The report says the commit is unconfirmed and how to fix that.

## Consequences

- Manifests from schema version 1 are not readable by `verification_get_report`.
- Confirmed alignment does not cover uncommitted changes in the checkout. The report says so.
- A preview that redirects the probe, for example to a login page, reports no commit unless the caller passes one.
