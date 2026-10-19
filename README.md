# katalepsis

A command-line tool that runs a project's Playwright tests, or plain-English checks driven by a model, against a preview deployment and writes a report for the pull request. Every check ends up passed, failed, blocked or not tested, with the screenshot, video and trace behind each failure.

```console
$ katalepsis run --cwd apps/demo-form --url http://127.0.0.1:4173
katalepsis: FAILED
  2 passed, 1 failed, 0 blocked, 0 not tested
  Report: artifacts/katalepsis/2026-10-10T12-45-00-937Z-bcfc2b/report.html
  Markdown: artifacts/katalepsis/2026-10-10T12-45-00-937Z-bcfc2b/report.md
```

That is a real run against the signup form in `apps/demo-form`, which has a deliberate bug: submitting it empty shows no error.

## Install

### Let your agent set it up

Paste this into Claude Code, Codex, Cursor or any other coding agent:

```text
Set up katalepsis for me by following https://www.katalepsis.glamboyosa.xyz/agents.md
```

[`agents.md`](apps/site/public/agents.md) walks the agent through the prerequisites, the installer, the project's Playwright config and connecting the MCP server to its own harness. It tells the agent to leave API keys to you. There is also an [`llms.txt`](https://www.katalepsis.glamboyosa.xyz/llms.txt).

### Install it yourself

Needs Node 22.12 or newer, git, and pnpm 10 (or corepack, which comes with Node). katalepsis is not on npm yet, so the installer builds it from this repository:

```bash
curl -fsSL https://www.katalepsis.glamboyosa.xyz/install.sh | sh
```

The address redirects to [`install.sh`](install.sh) in this repository.

It clones the repository into `~/.local/share/katalepsis`, runs `pnpm install` and `pnpm build` there, and writes two small launchers, `katalepsis` and `katalepsis-mcp`, into `~/.local/bin`. Set `KATALEPSIS_SOURCE_DIR` or `KATALEPSIS_INSTALL_DIR` to change those folders, and `KATALEPSIS_REF` to build a branch or tag other than `main`. Running the installer again updates the clone and rebuilds.

To run your own tests, the project you check needs `@playwright/test`, which any project with Playwright tests already has. You don't need to install browsers by hand: `katalepsis run --install-browsers` runs the project's own `playwright install` first, so the browsers always match its Playwright version, and agent checks download their own Chromium the first time they run.

What katalepsis touches on your machine:

- Reports go to `artifacts/katalepsis/<run-id>/` inside the project you check. `katalepsis init` adds `artifacts/katalepsis/` to that project's `.gitignore`.
- `katalepsis auth set` stores a key in the OS keychain under the service name `katalepsis`. `katalepsis auth forget <provider>` removes it.
- `katalepsis config` writes the chosen provider and model, never a key, to `~/.config/katalepsis/config.json` (or `$XDG_CONFIG_HOME/katalepsis`, or `$KATALEPSIS_HOME`).
- Browsers go into Playwright's shared cache (`~/Library/Caches/ms-playwright` on macOS, `~/.cache/ms-playwright` on Linux), not your project. The agent's Chromium takes about 200 MB, and `--install-browsers` downloads whatever your Playwright version installs by default, about 1 GB for Chromium, Firefox and WebKit. Set `KATALEPSIS_NO_BROWSER_DOWNLOAD=1` to stop the automatic download.
- katalepsis itself only calls your preview URL, Playwright's browser download servers when it installs a browser, and, for agent checks, Anthropic, OpenAI or OpenRouter with your key. Your own Playwright tests make whatever requests they already make.

To uninstall, run `katalepsis auth forget` for each provider you saved, then delete the config folder, `~/.local/share/katalepsis`, and the two launchers in `~/.local/bin`.

## Ways to use it

| You want to                                          | Use                              | You need                                                                                                               |
| ---------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Let your coding agent run tests and checks           | The MCP server in `packages/mcp` | Claude Code, Codex or any harness that speaks MCP, set up as in [docs/mcp.md](docs/mcp.md)                             |
| Run your existing Playwright tests against a preview | `katalepsis run`                 | A project with Playwright tests. No AI key.                                                                            |
| Check behaviour nobody has written a test for        | `katalepsis verify`              | An Anthropic, OpenAI or OpenRouter key                                                                                 |
| Run it on every pull request                         | Coming soon: a ready-made CI job | Until then, `katalepsis run` or `verify` in your own job works, untested in CI so far. Upload `artifacts/katalepsis/`. |

Every one of these writes the same report folder.

## Run your Playwright tests against a preview

Point your Playwright config at the URL katalepsis passes in, and turn on failure evidence:

```ts
use: {
  baseURL: process.env.KATALEPSIS_BASE_URL ?? "http://localhost:3000",
  screenshot: "only-on-failure",
  video: "retain-on-failure",
  trace: "retain-on-failure",
},
```

Then:

```bash
katalepsis init --cwd path/to/your-app
katalepsis run --cwd path/to/your-app --url https://your-preview.example.com
katalepsis report open --cwd path/to/your-app
```

`init` checks that Playwright is installed and prints the config snippet if it's missing. `run` accepts `--grep`, `--project` (repeatable), `--config`, `--timeout`, `--out`, `--install-browsers` and `--preview-commit`. If a browser can't start, the run is blocked and katalepsis tells you to add `--install-browsers`. No AI key is involved. If your Playwright config doesn't read `KATALEPSIS_BASE_URL`, `run` warns before it starts, since the tests would probably hit the `baseURL` in the config instead of the preview.

Each run folder can be zipped and attached to the pull request as it is:

```text
artifacts/katalepsis/<run-id>/
  report.html      open in a browser; evidence is linked by relative path
  report.md        paste into the PR description or a comment
  manifest.json    the validated results, schema version 2
  evidence/<check-id>/   screenshots, videos, traces, each with its SHA-256 in the manifest
  evidence/run/playwright.log
```

Query values in the preview URL, where preview hosts often put bypass tokens, are redacted from every text file in the bundle. Screenshots, videos and traces are recorded as Playwright made them, so use test data you're happy to share.

## Agent checks

For behaviour nobody has written a test for, describe the check and a model drives a real browser through it with your own Anthropic, OpenAI or OpenRouter key.

```bash
katalepsis auth set openrouter            # or anthropic / openai; or set OPENROUTER_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY
katalepsis config provider openrouter
katalepsis models openrouter              # lists real model IDs
katalepsis config model <model-id>
katalepsis verify --url https://your-preview.example.com --checks checks.json
```

```json
{
  "checks": [
    {
      "id": "empty-form",
      "name": "Empty form validation",
      "intent": "Submit the signup form without filling it",
      "passCondition": "A required-field error is visible"
    }
  ]
}
```

The model can click, type, read the page and run assertions, but it can't decide the result. A check passes only when the model cites a browser assertion that katalepsis ran, that passed, and that shows something which wasn't on the page before the model acted. A claim without that evidence is reported as blocked. Every check's report lists all the assertions it ran next to the pass condition, with a screenshot for each, a trace and the full action log.

How that is enforced:

- The model gets seven tools: `navigate`, `snapshot`, `click`, `fill`, `press`, `assert` and `finish`. It sees the page as an accessibility tree (roles, names and text) and the result of each tool. Screenshots are taken for the report and never sent to the model.
- `assert` is run by katalepsis in the browser, not judged by the model. Each one gets an ID such as `a3`, a screenshot and a line in the action log. `finish` must cite those IDs.
- Each check opens its start page twice, in two separate browser contexts. The model works in one; the other stays untouched. A "visible" assertion that also matches on the untouched copy was already there before the model acted, so it can't carry a pass on its own. Checks about the page as it loads can set `observeOnly` to skip this rule.
- A pass is blocked if a cited assertion failed, if it cites only hidden or URL assertions, if an assertion that wasn't cited failed after the cited ones, or if it cites an ID that never ran. A verdict with no citation is blocked.
- Browser actions run one at a time, even when the model sends several tool calls at once, so two `fill` calls can't type into the same field.
- Each check gets a fresh browser context with tracing on. Running out of steps, tokens or time, a model error, or leaving the allowed origins ends the check as blocked with the reason, never as failed.

The same demo checks with a real model:

```console
$ katalepsis verify --cwd apps/demo-form --url http://127.0.0.1:4173 --checks checks.json \
    --provider openrouter --model anthropic/claude-haiku-5.5
katalepsis: FAILED (openrouter/anthropic/claude-haiku-5.5)
  2 passed, 1 failed, 0 blocked
  Preview commit: not reported, so unconfirmed
  Report: artifacts/katalepsis/2026-10-10T12-45-05-343Z-b51a0a/report.html
  Markdown: artifacts/katalepsis/2026-10-10T12-45-05-343Z-b51a0a/report.md
```

Each check is limited by `--max-steps` (15), `--max-tokens` (200,000) and `--check-timeout` (120 seconds). The browser can't leave the preview's origin unless you add `--allow-origin <url>`. In CI, keys come only from environment variables.

## Check which commit the preview runs

A preview can lag behind your branch, so a green run may describe older code. katalepsis compares `HEAD` of the checkout with the commit the preview was built from, taking the first of these it finds:

1. An `x-commit-sha` response header on the preview URL.
2. A `<meta name="commit-sha" content="<sha>">` tag in the page's `<head>`, within its first 512 KB.
3. `--preview-commit <sha>` on `run` or `verify`, or `previewCommit` over MCP. Use it when CI knows the deployed commit, such as `github.event.deployment.sha` on a `deployment_status` event. Don't pass the pushed commit, such as `GITHUB_SHA`, since that is the commit you hope the preview has, not the one it has.

Preview hosts don't send any of these by default, but their builds know the commit: `VERCEL_GIT_COMMIT_SHA` on Vercel, `COMMIT_REF` on Netlify and `CF_PAGES_COMMIT_SHA` on Cloudflare Pages. In a Next.js app on Vercel, for example:

```tsx
<meta name="commit-sha" content={process.env.VERCEL_GIT_COMMIT_SHA} />
```

A short SHA of at least 7 characters is enough. The report shows the preview commit next to the checkout commit with one of three results:

| Result     | Meaning                                                     | Effect on the run                                                     |
| ---------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| confirmed  | The preview reported the checkout `HEAD`                    | None. Uncommitted changes are still not part of the preview.          |
| mismatched | The preview reported a different commit                     | A run that would pass is blocked (exit 2). A failed run stays failed. |
| unknown    | The preview reported nothing, or the checkout has no commit | None. The report says the commit is unconfirmed.                      |

The checks still run on a mismatch, so you can see what the deployed code does. A failure there is real for that deployment, so it isn't hidden, but a pass can't count as evidence for your checkout.

## From your agent harness

`packages/mcp` is a local MCP server with three tools: run the tests, run agent checks, and read a report. Any agent harness that speaks MCP can use it. It never takes a key as an argument and only works inside the folder you give it. For example, with Codex:

```bash
codex mcp add katalepsis -- katalepsis-mcp --root /path/to/your-app
```

In `~/.codex/config.toml`, set `tool_timeout_sec = 600` for it, since Codex's default is 60 seconds, and `default_tools_approval_mode = "approve"` if you use `codex exec`, which can't ask before a tool call. Setup for other harnesses, including Claude Code and Cursor, is in [docs/mcp.md](docs/mcp.md).

<details>
<summary>How results are decided</summary>

For Playwright runs, Playwright's own outcome stands. katalepsis reads its JSON reporter output and never reinterprets an assertion.

- A test that fails because the preview couldn't be reached is blocked, not failed. A dead third-party or API host stays failed, because that is a problem with the app.
- A test whose browser couldn't start is blocked.
- A test that passed only on retry is passed and marked flaky, with every attempt listed.
- Skipped tests, tests excluded by `--grep` or `--project`, and tests Playwright listed but never ran are listed as not tested. The last of these also blocks the run.
- A run where nothing ran is blocked.

Before starting a browser, katalepsis requests the preview URL. A network error or an HTTP 502, 503 or 504 blocks every selected test.

The commit in the report is `HEAD` of the project checkout, or `unknown`. A preview that reports a different commit blocks a run that would pass; see [Check which commit the preview runs](#check-which-commit-the-preview-runs).

Ctrl-C stops Playwright and its browsers and still writes a blocked report. A second Ctrl-C quits at once.

</details>

<details>
<summary>Exit codes</summary>

| Code | Meaning                                                                                |
| ---- | -------------------------------------------------------------------------------------- |
| 0    | Every check that ran passed                                                            |
| 1    | At least one check failed                                                              |
| 2    | Blocked: the preview or browser was unavailable, the run was cancelled, or nothing ran |
| 3    | Usage or setup error; no report was written                                            |
| 4    | The report couldn't be written                                                         |

</details>

<details>
<summary>Repository layout and docs</summary>

```text
packages/core          result schemas, Playwright runner and report ingest, evidence store, renderers
packages/credentials   keys (environment, then OS keychain) and non-secret preferences
packages/agent         agent checks: browser tools, evidence rules, Anthropic, OpenAI and OpenRouter models
packages/mcp           the stdio MCP server
packages/cli           the katalepsis command
apps/demo-form         a signup form with a deliberate bug, three Playwright tests and checks.json
apps/site              the landing page and the product video
```

- [ADR 0001](docs/adr/0001-playwright-results-report-schema-and-boundaries.md): result authority, report schema and boundaries
- [ADR 0002](docs/adr/0002-agent-checks-and-byok.md): how agent checks are decided, limits, keys and models
- [ADR 0003](docs/adr/0003-mcp-server.md): the MCP server
- [ADR 0004](docs/adr/0004-preview-commit-alignment.md): comparing the preview's commit with the checkout
- [MCP setup](docs/mcp.md)
- [Reference review](docs/reference-review.md): how Docket and Conclave handle keys
- [Implementation status](IMPLEMENTATION_STATUS.md): what's built, what was tested and known limitations
- [Contributing](CONTRIBUTING.md)

</details>

## License

MIT. See [LICENSE](LICENSE).
