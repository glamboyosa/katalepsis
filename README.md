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

Needs Node 22.12 or newer, git, and pnpm 10 (or corepack, which comes with Node). katalepsis is not on npm yet, so the installer builds it from this repository:

```bash
curl -fsSL https://katalepsis.glamboyosa.xyz/install.sh | sh
```

The address redirects to [`install.sh`](install.sh) in this repository.

It clones the repository into `~/.local/share/katalepsis`, runs `pnpm install` and `pnpm build` there, and writes two small launchers, `katalepsis` and `katalepsis-mcp`, into `~/.local/bin`. Set `KATALEPSIS_SOURCE_DIR` or `KATALEPSIS_INSTALL_DIR` to change those folders, and `KATALEPSIS_REF` to build a branch or tag other than `main`. Running the installer again updates the clone and rebuilds.

To run your own tests, the project you check needs `@playwright/test`, which any project with Playwright tests already has. You don't need to install browsers by hand: `katalepsis run --install-browsers` runs the project's own `playwright install` first, so the browsers always match its Playwright version, and agent checks download their own Chromium the first time they run.

What katalepsis touches on your machine:

- Reports go to `artifacts/katalepsis/<run-id>/` inside the project you check. `katalepsis init` adds `artifacts/katalepsis/` to that project's `.gitignore`.
- `katalepsis auth set` stores a key in the OS keychain under the service name `katalepsis`. `katalepsis auth forget <provider>` removes it.
- `katalepsis config` writes the chosen provider and model, never a key, to `~/.config/katalepsis/config.json` (or `$XDG_CONFIG_HOME/katalepsis`, or `$KATALEPSIS_HOME`).
- Browsers go into Playwright's shared cache (`~/Library/Caches/ms-playwright` on macOS, `~/.cache/ms-playwright` on Linux), not your project. The agent's Chromium takes about 200 MB, and `--install-browsers` downloads whatever your Playwright version installs by default, about 1 GB for Chromium, Firefox and WebKit. Set `KATALEPSIS_NO_BROWSER_DOWNLOAD=1` to stop the automatic download.
- katalepsis itself only calls your preview URL, Playwright's browser download servers when it installs a browser, and, for agent checks, OpenAI or OpenRouter with your key. Your own Playwright tests make whatever requests they already make.

To uninstall, run `katalepsis auth forget` for each provider you saved, then delete the config folder, `~/.local/share/katalepsis`, and the two launchers in `~/.local/bin`.

## Ways to use it

| You want to                                          | Use                                                                        | You need                                                                                                                |
| ---------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Run your existing Playwright tests against a preview | `katalepsis run`                                                           | A project with Playwright tests. No AI key.                                                                             |
| Check behaviour nobody has written a test for        | `katalepsis verify`                                                        | An OpenAI or OpenRouter key                                                                                             |
| Let Claude Code, Codex or Cursor run either of those | The MCP server in `packages/mcp`                                           | The client set up as in [docs/mcp.md](docs/mcp.md)                                                                      |
| Run it in CI                                         | `katalepsis run` or `verify` in a job, then upload `artifacts/katalepsis/` | Node and pnpm in the job, keys as secrets for `verify`. Not tested in CI yet, and there is no ready-made GitHub Action. |

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

`init` checks that Playwright is installed and prints the config snippet if it's missing. `run` accepts `--grep`, `--project` (repeatable), `--config`, `--timeout`, `--out` and `--install-browsers`. If a browser can't start, the run is blocked and katalepsis tells you to add `--install-browsers`. No AI key is involved.

Each run folder can be zipped and attached to the pull request as it is:

```text
artifacts/katalepsis/<run-id>/
  report.html      open in a browser; evidence is linked by relative path
  report.md        paste into the PR description or a comment
  manifest.json    the validated results, schema version 1
  evidence/<check-id>/   screenshots, videos, traces, each with its SHA-256 in the manifest
  evidence/run/playwright.log
```

Query values in the preview URL, where preview hosts often put bypass tokens, are redacted from every text file in the bundle. Screenshots, videos and traces are recorded as Playwright made them, so use test data you're happy to share.

## Agent checks

For behaviour nobody has written a test for, describe the check and a model drives a real browser through it with your own OpenAI or OpenRouter key.

```bash
katalepsis auth set openrouter            # or set OPENROUTER_API_KEY / OPENAI_API_KEY
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

The same demo checks with a real model:

```console
$ katalepsis verify --cwd apps/demo-form --url http://127.0.0.1:4173 --checks checks.json \
    --provider openrouter --model anthropic/claude-haiku-5.5
katalepsis: FAILED (openrouter/anthropic/claude-haiku-5.5)
  2 passed, 1 failed, 0 blocked
  Report: artifacts/katalepsis/2026-10-10T12-45-05-343Z-b51a0a/report.html
  Markdown: artifacts/katalepsis/2026-10-10T12-45-05-343Z-b51a0a/report.md
```

Each check is limited by `--max-steps` (15), `--max-tokens` (200,000) and `--check-timeout` (120 seconds). The browser can't leave the preview's origin unless you add `--allow-origin <url>`. In CI, keys come only from environment variables.

## From Claude Code, Codex or Cursor

`packages/mcp` is a local MCP server with three tools: run the tests, run agent checks, and read a report. It never takes a key as an argument and only works inside the folder you give it. For Codex:

```bash
codex mcp add katalepsis -- katalepsis-mcp --root /path/to/your-app
```

In `~/.codex/config.toml`, set `tool_timeout_sec = 600` for it, since Codex's default is 60 seconds, and `default_tools_approval_mode = "approve"` if you use `codex exec`, which can't ask before a tool call. Claude Code and Cursor setup is in [docs/mcp.md](docs/mcp.md).

<details>
<summary>How results are decided</summary>

For Playwright runs, Playwright's own outcome stands. katalepsis reads its JSON reporter output and never reinterprets an assertion.

- A test that fails because the preview couldn't be reached is blocked, not failed. A dead third-party or API host stays failed, because that is a problem with the app.
- A test whose browser couldn't start is blocked.
- A test that passed only on retry is passed and marked flaky, with every attempt listed.
- Skipped tests, tests excluded by `--grep` or `--project`, and tests Playwright listed but never ran are listed as not tested. The last of these also blocks the run.
- A run where nothing ran is blocked.

Before starting a browser, katalepsis requests the preview URL. A network error or an HTTP 502, 503 or 504 blocks every selected test.

The commit in the report is `HEAD` of the project checkout, or `unknown`. katalepsis doesn't confirm the preview was built from it.

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
packages/agent         agent checks: browser tools, evidence rules, OpenAI and OpenRouter models
packages/mcp           the stdio MCP server
packages/cli           the katalepsis command
apps/demo-form         a signup form with a deliberate bug, three Playwright tests and checks.json
apps/site              the landing page and the product video
```

- [ADR 0001](docs/adr/0001-playwright-results-report-schema-and-boundaries.md): result authority, report schema and boundaries
- [ADR 0002](docs/adr/0002-agent-checks-and-byok.md): how agent checks are decided, limits, keys and models
- [ADR 0003](docs/adr/0003-mcp-server.md): the MCP server
- [MCP setup](docs/mcp.md)
- [Reference review](docs/reference-review.md): how Docket and Conclave handle keys
- [Implementation status](IMPLEMENTATION_STATUS.md): what's built, what was tested and known limitations
- [Contributing](CONTRIBUTING.md)

</details>

## License

MIT. See [LICENSE](LICENSE).
