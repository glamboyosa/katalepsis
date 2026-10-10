# katalepsis

katalepsis runs your existing Playwright tests against a preview URL and writes a report bundle you can attach to a pull request. The report shows what passed, what failed, what was blocked and what was not tested, with screenshots, videos and traces linked from each failure.

It runs locally. It needs no account, no database and no AI key.

> Status: early. The Playwright runner (M1), agent checks with your own OpenAI or OpenRouter key (M2) and the MCP server for coding agents (M3) work. The GitHub Action is not built yet. See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

## Requirements

- Node 22.12 or newer
- pnpm 10
- A project with `@playwright/test` installed and its browsers available (`npx playwright install`)

## Install

katalepsis is not published to npm yet. Build it from a clone:

```bash
git clone <this repository> katalepsis
cd katalepsis
pnpm install
pnpm build
```

The CLI is then at `packages/cli/dist/main.js`. The examples below use `katalepsis` for `node /path/to/katalepsis/packages/cli/dist/main.js`.

## Use it with your own Playwright suite

1. Make your Playwright config read the preview URL from `KATALEPSIS_BASE_URL`, and turn on failure evidence:

   ```ts
   use: {
     baseURL: process.env.KATALEPSIS_BASE_URL ?? "http://localhost:3000",
     screenshot: "only-on-failure",
     video: "retain-on-failure",
     trace: "retain-on-failure",
   },
   ```

   katalepsis does not change your config. If a failing test has no screenshot, video or trace, the report says which setting is missing.

2. Check the project and ignore the report folder in git:

   ```bash
   katalepsis init --cwd path/to/your-app
   ```

3. Run your tests against a preview:

   ```bash
   katalepsis run --cwd path/to/your-app --url https://your-preview.example.com
   ```

   Narrow the run with `--grep <pattern>` or `--project <name>` (repeatable). Use `--config <file>` if the config is not in the project root; a relative path is resolved against `--cwd`.

4. Open the report:

   ```bash
   katalepsis report open --cwd path/to/your-app
   ```

Reports are written to `artifacts/katalepsis/<run-id>/` in the project. Use `--out <dir>` to change that.

## Attach the report to a pull request

Each run folder is self-contained:

```text
artifacts/katalepsis/<run-id>/
  report.html      # open in a browser; evidence is linked by relative path
  report.md        # paste into a PR description or comment
  manifest.json    # the validated result data, schema version 1
  evidence/<check-id>/retry-<n>-screenshot.png, -video.webm, -trace.zip, ...
  evidence/run/playwright.log   # Playwright's output; list-*.log too when listing tests failed
```

Zip the run folder and attach it to the PR, or upload it as a CI artifact. Paste `report.md` into the PR for the summary. Open a trace with `npx playwright show-trace evidence/<check-id>/retry-0-trace.zip`.

Screenshots, videos and traces are not redacted. They can show the preview URL, cookies and anything typed into the page. Use synthetic test data before you share them. Query values in the preview URL are redacted from the manifest, the Markdown and HTML reports, error messages and the Playwright log.

## Exit codes

| Code | Meaning                                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Every check that ran passed                                                                                                      |
| 1    | At least one check failed                                                                                                        |
| 2    | Blocked: the preview was unreachable, the browser could not start, Playwright could not finish or was cancelled, or no tests ran |
| 3    | Usage or setup error, such as an invalid URL or no Playwright install. No report was written.                                    |
| 4    | The report bundle could not be written                                                                                           |

## How results are decided

Playwright decides pass and fail. katalepsis reads its JSON reporter output and does not reinterpret assertions.

- A test that fails because the preview could not be reached is **blocked**, not failed.
- A test that passed only on retry is **passed** and marked **flaky**, with every attempt listed.
- Skipped tests and tests excluded by `--grep` or `--project` are listed under **Not tested**.
- A test that could not start a browser is **blocked**.
- A test that fails because some other host was unreachable stays **failed**; that is a problem with the app, not the preview.
- A run where no test ran is **blocked**, never passed.

Press Ctrl-C once to stop a run: katalepsis stops Playwright and its browsers and still writes a blocked report. Press it again to stop everything at once and quit.

Before starting Playwright, katalepsis requests the preview URL. If it gets a network error or HTTP 502, 503 or 504, every selected test is reported as blocked and no browser starts.

The commit shown is `HEAD` of the project checkout, or `unknown` when there is none. katalepsis does not confirm the preview was built from that commit.

## Agent checks with your own key

Agent checks cover behaviour you have not written a Playwright test for. You describe each check, a model drives a real browser, and katalepsis decides the result from browser assertions, not from what the model says.

1. Store a key in the OS keychain, or set `OPENAI_API_KEY` or `OPENROUTER_API_KEY`. The environment variable wins. In CI (`CI` set) only the environment is used.

   ```bash
   katalepsis auth set openrouter
   katalepsis auth status
   ```

2. Pick a provider and a model. There is no default model; `config model` checks the ID against the provider's catalog.

   ```bash
   katalepsis config provider openrouter
   katalepsis models openrouter
   katalepsis config model <model-id>
   ```

   `--provider` and `--model` on `verify`, or `KATALEPSIS_PROVIDER` and `KATALEPSIS_MODEL`, override the saved choice.

3. Write a checks file. Every check needs an `id`, a `name`, an `intent` and a `passCondition` that describes something visible. `startPath` is optional.

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

4. Run it:

   ```bash
   katalepsis verify --url https://your-preview.example.com --checks checks.json
   ```

A check **passes** only when the model cites browser assertions that katalepsis ran and that all passed, at least one of them shows something visible, and at least one shows something that was not on the page before the agent acted. A page the agent opened by typing its URL counts as already there. For a check about the page as it loads, with nothing to do, set `"observeOnly": true`. A failed assertion after the cited ones also blocks the pass. A check **fails** only when a cited assertion failed. A claim without that evidence, a check that runs out of steps, tokens or time, and a page that tries to leave the preview's origin are all **blocked**. Each check's report shows the cited assertions, a screenshot for each, a Playwright trace and the full action log. Compare the cited assertions with the pass condition: they prove what the page showed, not that the model asked the right question.

Agent checks drive their own Chromium through `playwright-core` 1.63, separate from your project's Playwright. If it is missing, install it once:

```bash
pnpm --filter @katalepsis/agent exec playwright-core install chromium-headless-shell
```

Limits: `--max-steps` (default 15), `--max-tokens` (default 200,000) and `--check-timeout` in seconds (default 120) per check. `--allow-origin <url>` lets the browser visit another origin, such as a login provider. Leaving the allowed origins, by a link, a redirect or a new tab, blocks the check. `startPath` must be a path on the preview, such as `/signup`. Use only synthetic test data: screenshots and traces are not redacted.

Keys never reach `config.json`, the console, or any text file in the report bundle: they and the preview URL's query values are redacted before those files are written. Traces and screenshots are images and recordings, so they are not redacted.

## Use it from Claude Code, Codex or Cursor

`packages/mcp` is a local MCP server with three tools: run the Playwright tests, run agent checks, and read a report. Setup for each client, and what was tested, is in [docs/mcp.md](docs/mcp.md). For Codex:

```bash
codex mcp add katalepsis -- node /path/to/katalepsis/packages/mcp/dist/main.js --root /path/to/your-app
```

Then set `tool_timeout_sec = 600` for it in `~/.codex/config.toml`, because test runs take longer than Codex's 60-second default.

## Try the demo

The repository includes a small signup form with a deliberate bug: submitting it empty shows no error.

```bash
pnpm --filter demo-form serve
```

In another terminal:

```bash
node packages/cli/dist/main.js run --cwd apps/demo-form --url http://127.0.0.1:4173
```

The report shows 2 passed and 1 failed, with a screenshot, video and trace for the failure. Stop the server and run the same command to see all three checks reported as blocked.

The same three behaviours as agent checks, with your key set up as above:

```bash
node packages/cli/dist/main.js verify --cwd apps/demo-form --url http://127.0.0.1:4173 --checks checks.json
```

## Documentation

- [Reference review](docs/reference-review.md): credential handling in Docket and Conclave, and what katalepsis takes from each
- [ADR 0001](docs/adr/0001-playwright-results-report-schema-and-boundaries.md): result authority, report schema, credentials and browser boundaries
- [ADR 0002](docs/adr/0002-agent-checks-and-byok.md): how agent checks are decided, limits, credentials and models
- [MCP setup](docs/mcp.md): Claude Code, Codex and Cursor
- [Contributing](CONTRIBUTING.md)
