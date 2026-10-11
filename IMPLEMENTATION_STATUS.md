# Implementation status

Last updated: 2026-10-10.

## Milestones

| Milestone                                      | State                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| M0: reference review, ADR, monorepo tooling    | Done                                                                             |
| M1: deterministic Playwright runner and report | Done, except the external-developer gate below                                   |
| M2: BYOK and agent checks                      | Done and reviewed; started at your request before the M1 external-developer gate |
| M3: local MCP server                           | Done; tested with Codex CLI, not with Claude Code or Cursor                      |
| M4: GitHub Action                              | Not started                                                                      |

### M0

- [docs/reference-review.md](docs/reference-review.md) records Docket and Conclave at their commit SHAs, credential lookup order, providers, redaction and the choices katalepsis makes.
- [docs/adr/0001-playwright-results-report-schema-and-boundaries.md](docs/adr/0001-playwright-results-report-schema-and-boundaries.md) covers result authority, the report schema, credentials and browser boundaries.
- pnpm workspace with `packages/core`, `packages/cli` and `apps/demo-form`. Scripts: `format`, `format:check`, `lint`, `typecheck`, `test`, `test:integration`, `check`.
- M0 itself added no credential, AI or MCP dependency. M2 added the AI SDK, the OpenAI and OpenRouter providers, `playwright-core` and `@napi-rs/keyring`. M3 added the MCP TypeScript SDK; the server now uses `@modelcontextprotocol/server` 2.3.1, which implements the 2026-07-28 specification, and the tests use `@modelcontextprotocol/client` 2.3.1 and the version 1 `@modelcontextprotocol/sdk` 1.32.1 as an older client.

### M1

- `katalepsis init`, `katalepsis run`, `katalepsis report open`.
- Runs the project's own `@playwright/test`, with `--config`, `--project`, `--grep` and `--timeout`. The preview URL reaches tests as `KATALEPSIS_BASE_URL`.
- Lists all declared tests before running, so filtered, skipped and unreported tests appear under "Not tested".
- Probes the preview first. If it is unreachable, every selected test is blocked and Playwright is not run.
- Decodes Playwright's JSON report with Effect Schema and maps it to versioned `VerificationRun` data. Keeps raw titles, assertion errors, attempts, retries and project names.
- Copies attachments into `evidence/<check-id>/` with generated names, byte length and SHA-256.
- Writes `manifest.json`, `report.md` and `report.html`. HTML is escaped and has a restrictive Content Security Policy.
- Redacts preview URL query values from every text file in the bundle.
- Exit codes: 0 passed, 1 failed, 2 blocked, 3 usage or setup error, 4 report write failure.

### M2

Checklist and deviations from the plan, set at the start of the milestone:

- Credentials: environment, then OS keychain (`@napi-rs/keyring`), never the keychain in CI. `auth set/status/forget`, `config provider/model/show`, `models <provider>`.
- Providers: Anthropic, OpenAI and OpenRouter through AI SDK 7 (`ToolLoopAgent`). Model IDs are checked against the provider catalog before any check runs. No default model.
- Browser: `playwright-core` driven directly, not Playwright MCP (allowed by the plan; see ADR 0002). One isolated context per check, with tracing.
- Checks file: `id`, `name`, `intent`, `passCondition`, optional `startPath`, validated with Effect Schema. Free-form prose is rejected.
- Evidence rule: a pass needs a cited, passing browser assertion; anything else unproven is blocked. See [ADR 0002](docs/adr/0002-agent-checks-and-byok.md).
- Limits: steps, tokens and time per check; navigation outside the allowlist blocks the check; Ctrl-C stops the run.
- Same report schema and renderers as M1, with `source: "agent"` and the run's `model`.
- Not done: Google and OpenAI-compatible endpoints; Claude Code or Codex integration, which belongs to M3's MCP server.

Live runs on the demo form found three bugs that the fake-model tests then pinned:

- A model's parallel tool calls ran at the same time, so two `fill` calls typed both values into one field. Browser actions now run in order.
- Parallel `assert` calls got the same ID.
- Effect renders an empty struct as "not null", which OpenAI rejects as a tool schema, and optional fields as nullable, which the validator then refused. No-input tools now use an explicit object schema, and optional fields use exact optional keys.

A fourth change came from reading a live report: GPT-5.4 mini cited `text "email" is visible`, which matched the field label. Assertions now match exactly.

An independent review of M2 found one high-severity gap: a model could get a pass by citing an assertion that proved nothing, such as "this missing text is hidden", or a heading that was on the page before it acted. The pass rule now requires a cited "visible" assertion, checks it against an untouched copy of the start page, and refuses a pass when a later assertion failed. The review also found that redirects and new tabs slipped past the allowlist, that a bad OpenRouter key was not caught before checks ran, and smaller issues with usage reporting, error codes, empty environment values and docs. All are fixed and tested. A re-review then found that a check could still pass with no action at all by citing the starting page, and that opening a page by URL counted as causing its content. A pass now needs something that was not on the page at the start, unless the check sets `observeOnly`, and pages the agent opens by URL are mirrored on the untouched copy. After the stricter rules, live runs with both providers still gave 2 passed and 1 failed.

## Commands run and results

On macOS, Node 23.9.0, pnpm 10.17.1:

| Command                                                                      | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                                                                 | Format, lint and typecheck clean. 112 unit tests pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `pnpm test:integration`                                                      | 42 tests pass. MCP (12): the test client in packages/mcp, including cancellation, client exit, symlinks, duplicate IDs and unknown arguments. M1 (9): demo gives 2 passed and 1 failed (exit 1); offline preview gives 3 blocked (exit 2); `report open --print`; `file:` URL exits 3; `--config` resolves against `--cwd`; missing `--config` exits 3; unwritable `--out` exits 4; `--timeout 1` blocks with the Playwright log kept; Ctrl-C mid-run exits 2 with a blocked report and no Playwright, browser or ffmpeg process left. Agent (21): fake-model checks in a real browser covering the evidence rules, allowlist redirects and popups, cancellation, timeouts, and the API key never reaching the bundle. |
| `katalepsis run` against the demo with `?token=...` in the URL               | Exit 1, 2 passed, 1 failed. Screenshot, video, trace and error context bundled. The token appears in no text file in the bundle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `katalepsis run --grep "valid submission"`                                   | Exit 0, 1 passed, 2 listed as excluded by the filter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `katalepsis init` on a project without the env var or capture settings       | Prints the config snippet and adds `artifacts/katalepsis/` to `.gitignore`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| HTML report opened over `file://` in headless Chromium at 1280 px and 375 px | Screenshot and video load, no console errors, no horizontal scroll.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### Independent review

A fresh reviewer checked M0 and M1 and reported 15 findings: 1 high, 7 medium and 7 low. All were fixed:

- Ctrl-C and SIGTERM now stop Playwright's whole process group and still write a blocked report. Before, Playwright, Chromium and ffmpeg kept running and no report was written.
- A browser that cannot launch is blocked, not failed.
- Redaction catches query values containing `+` and lowercase percent-escapes.
- Playwright's output is kept in the bundle and quoted in the error when listing or running fails.
- `--config` resolves against `--cwd` and is checked before the run.
- Listing errors are recorded once, and the report no longer claims every test ran when listing failed.
- Only network errors that name the preview's origin are blocked; other hosts stay failed.
- Exit 4, `--timeout` and cancellation have integration tests.
- Evidence capture time is the end of the attempt that produced it.
- When the preview is down, tests skipped at declaration are listed as not tested, and blocked checks keep their line and title path.
- `repeatEach` repeats get distinct check IDs.
- A `test.fail()` test reads "Failed as expected".
- The skipped-test decision is recorded in the ADR.

A second fresh reviewer confirmed 13 of those fixes and found 2 partly fixed, plus 7 smaller issues. All are now fixed:

- An offline preview's report says Playwright was not run, instead of "Every declared test ran."
- A failed listing stops the run without starting Playwright, and does not label tests as excluded by the filter.
- Cancelling during listing or the preview check stops at once with a single cancellation error. The preview check honours cancellation.
- Only Playwright's own launch errors count as a browser problem; assertion text mentioning a launch failure stays a failure.
- A test Playwright listed but never reported blocks the run. Listing now sees `KATALEPSIS_BASE_URL`.
- A second Ctrl-C kills Playwright's process group before exiting, and SIGHUP is handled like SIGTERM.
- The cancel and timeout integration tests check that no Playwright-managed browser or ffmpeg process is left.
- A `test.fail()` test that unexpectedly passes is explained in plain words.
- The ADR states where it departs from the plan's "all declared checks passed" wording, and why.

M2, on macOS with Node 23.9.0, demo form at `http://127.0.0.1:4173`:

| Command                                                                                           | Result                                                                                  |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `katalepsis verify --checks checks.json --provider openrouter --model anthropic/claude-haiku-5.5` | Exit 1: empty-form failed, valid-submission passed, invalid-email passed. About 30 s.   |
| `katalepsis verify ... --provider openai --model gpt-5.4-mini`                                    | Exit 1, same 2 passed and 1 failed.                                                     |
| `verify` against a closed port                                                                    | Exit 2: 3 blocked, `preview-unavailable`, no model call.                                |
| `verify` with no OpenAI key                                                                       | Exit 2: 3 blocked, `credentials` error naming `auth set openai`.                        |
| `verify` with model `gpt-nonexistent-9`                                                           | Exit 2: 3 blocked, `configuration` error from the catalog check.                        |
| `auth set openrouter` with a piped dummy value, `auth status`, `auth forget openrouter`           | Saved to and removed from the macOS keychain; status showed `keychain`, then `missing`. |
| `KATALEPSIS_PROVIDER=openrouter KATALEPSIS_MODEL=anthropic/claude-haiku-5.5 pnpm test:live`       | 1 test passes: 2 passed, 1 failed, no key in the bundle.                                |
| grep of every live bundle for `sk-`, `sk-or-`, `sk-proj`                                          | No matches.                                                                             |

### M3

- `packages/mcp`: a stdio MCP server with `verification_run_tests`, `verification_check_browser` and `verification_get_report`. See [ADR 0003](docs/adr/0003-mcp-server.md) and [docs/mcp.md](docs/mcp.md).
- `packages/mcp/test/mcp.integration.test.ts` is the test MCP client: it lists the tools, runs the demo's tests, reads the report back, gets a clear `configuration` error for agent checks with no model set, refuses a `cwd` outside the root, rejects bad arguments, and turns away a second concurrent run.
- `pnpm mcp:demo <url>` is the scripted end-to-end call.
- With Codex CLI 0.160.0, `codex exec` with runtime `-c mcp_servers.katalepsis.*` flags called `verification_run_tests` (2 passed, 1 failed) and `verification_check_browser` with OpenRouter and Claude Haiku 5.5 (empty-form failed, the other two passed). Without `env_vars`, Codex did not pass `OPENROUTER_API_KEY` to the server and the check was blocked with a `credentials` error, which the docs now cover. In a later `codex exec`, Codex ran the tests and then read the report back with `verification_get_report`, which is the M3 gate. Your `~/.codex/config.toml` was not changed.
- An independent review of M3 found that a client quitting mid-run killed the server and left Playwright and its browsers running with no report, that a crafted symlink in a project could make `verification_get_report` read files outside it, that agent checks sent over MCP skipped the duplicate-ID rule, and smaller issues with the default run time, error messages, published schemas and docs. All are fixed and covered by the MCP tests.
- Claude Code and Cursor setup follows their documentation and Playwright MCP's published configs, but was not run here.

### Landing page and video

- `apps/site`: a static landing page with its own pixel sprite (a page under a lens, then a check), checked at 320, 390, 768 and 1440 px wide with no horizontal scroll and no console errors.
- `apps/site/public/katalepsis-demo.mp4`: a 47-second 1920×1080 H.264 video, rendered frame by frame from real CLI output and real report screenshots, encoded with AVFoundation. See `apps/site/README.md`.
- The page links to `github.com/glamboyosa/katalepsis`, which does not exist until the repository is pushed.

## Known limitations

- **External-developer gate not done.** The M1 gate needs another developer to install from the README, run their own suite and attach the bundle to a PR without help. That has not happened.
- **Not published to npm.** `install.sh` builds katalepsis from GitHub and puts `katalepsis` and `katalepsis-mcp` launchers in `~/.local/bin`.
- **Base URL wiring is trusted, not verified.** Playwright's JSON report does not include `use.baseURL`, so katalepsis cannot prove the config read `KATALEPSIS_BASE_URL`. When the config file doesn't mention it at all, `run` prints a warning and the report says the tests most likely ran against the config's own baseURL. Conclave and a work project both hardcode their baseURL.
- **The project's reporters are replaced** by the JSON reporter during a katalepsis run.
- **Evidence is not redacted.** Screenshots, videos and traces are copied as Playwright wrote them. The report warns about this.
- **Inline attachments** (`testInfo.attach` with a body instead of a path) are counted but not bundled.
- **Commit is the local checkout's HEAD.** There is no check that the preview was built from it. Uncommitted changes are not detected.
- **Node 23, macOS only.** Development used Node 23.9.0 on macOS. Vitest 5 declares support for Node 22.12, 24 and 26 but not 23; it ran without problems. Not yet run on Node 22 or 24, Linux or Windows. On Windows, cancellation signals only the Playwright process, not its whole process tree.
- **Playwright version.** Tested with Playwright 1.63.0 only, because 1.64 needs a browser build not installed on this machine.
- **No ZIP output.** Attach the run folder by zipping it yourself.
- **Agent checks prove what the page showed, not that the right thing was asked.** A model can cite a true but irrelevant assertion, for example that an element that never existed is hidden. The report lists every cited assertion next to the pass condition so a reviewer can judge.
- **Short-lived messages can be missed.** A confirmation that disappears within a second or two, such as Docket's "copied" label, can be gone before the model asserts it, so the check fails even though the page worked. Claude Haiku 5.5 caught Docket's label; GPT-5.4 mini missed it in three runs.
- **Agent results vary by model and run.** The decision rules are fixed by tests; the actions a model takes are not.
- **Assertions are visible, hidden and URL-contains only.** Pass conditions about other things, such as a value in a field, end blocked.
- **Agent checks are not redacted in screenshots or traces**, the same as M1 evidence.
- **The leftover-browser check in the integration tests** counts any new `ms-playwright` process, so another Playwright run on the same machine could make it fail. Fine locally; it may need narrowing for shared CI.

## Next smallest step

Ask one developer with an existing Playwright suite to follow the README against a real preview, run the three demo agent checks with their own key, and attach the bundle to a PR. Fix what they trip on. Then M4, the GitHub Action, once there is demand for it.
