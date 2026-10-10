# ADR 0002: Agent checks and bring-your-own-key models

- Status: accepted for M2
- Date: 2026-10-10

## Context

M2 adds checks written in plain language: an intent and an explicit pass condition. A model drives a browser to carry them out, using the user's own OpenAI or OpenRouter key. The risk this ADR addresses is a model reporting a pass that nothing on the page supports.

## Decisions

### 1. The model proposes; the browser decides

The model works only through tools: `navigate`, `snapshot`, `click`, `fill`, `press`, `assert` and `finish`. `assert` runs a deterministic Playwright check (an element is visible, an element is hidden, or the URL contains a value) and records the result with a screenshot. `finish` reports a verdict and cites assertion IDs.

`decideOutcome` (`packages/agent/src/outcome.ts`) turns that into a status:

| The model reports                                                                     | katalepsis records     |
| ------------------------------------------------------------------------------------- | ---------------------- |
| passed, citing assertions that all passed, including a "visible" one the agent caused | passed                 |
| passed, citing only "hidden" or "URL contains" assertions                             | blocked, `no-evidence` |
| passed, citing only things already visible before the agent acted                     | blocked, `no-evidence` |
| passed, but an uncited assertion after the cited ones failed                          | blocked, `no-evidence` |
| failed, citing at least one assertion that failed                                     | failed                 |
| passed or failed without citing an assertion                                          | blocked, `no-evidence` |
| passed, but a cited assertion failed                                                  | blocked, `no-evidence` |
| failed, but every cited assertion passed                                              | blocked, `no-evidence` |
| an assertion ID that never ran                                                        | blocked, `no-evidence` |
| blocked, or no `finish` at all                                                        | blocked                |
| anything, after running out of steps, tokens or time                                  | blocked, `budget`      |
| anything, after the page tried to leave the allowlist                                 | blocked, `navigation`  |

The model's summary is shown, labelled "not evidence". Assertions match text and accessible names exactly, so a short word cannot pass by matching a field label. Actions such as click and fill match loosely, as a person would.

To tell what the agent caused from what was always there, each check keeps untouched copies in a second browser context: one of the start page, and one of every page the agent opens by URL with `navigate`, because opening a page is not causing what it shows. Every "visible" assertion also runs against each copy. A pass needs at least one cited "visible" assertion that was false on all of them, unless the check sets `observeOnly`, which is for checks about the page as it loads. Failed assertions before the cited ones are allowed, because models often try a few wordings before finding the real message; a failure after them is not.

If a copy cannot be loaded, the check is blocked with `navigation`. The copies have their own allowlist guard and load each page a second time. A start URL with side effects or a single-use token can therefore behave differently on the copy.

Pages reached by clicking count as changes the agent caused, which is usually right (a form leading to a thank-you page) but means a click on an ordinary navigation link can produce a pass about that page's content.

What this still does not prove: that the cited assertions are the right ones for the pass condition. A model can cite a true change that is beside the point. The report therefore lists every assertion that ran, cited ones first, next to the pass condition, with screenshots, and says so in Limitations.

### 2. Bounded, isolated, ordered

- Each check gets a new browser context with tracing on, so a trace, assertion screenshots and an action log are always available.
- Limits per check: steps (`--max-steps`, default 15), total tokens (`--max-tokens`, default 200,000) and wall time (`--check-timeout`, default 120 s). Hitting any limit blocks the check.
- Top-level navigation to an origin outside the preview's own, plus any `--allow-origin`, blocks the check. A context-level route aborts direct navigations and popups; a main-frame listener catches redirects, which routes only see for their first URL; popups are closed. Subresources from other origins still load.
- If the start page does not load, the check is blocked with `navigation` before the model is called. `startPath` must be a path on the preview.
- Tool calls a model makes in one step run one after another. Live testing showed parallel `fill` calls typing into the wrong field.
- Checks run one at a time. Ctrl-C stops the run; checks not yet started are reported as blocked.

### 3. Credentials and models

Following [the reference review](../reference-review.md):

- Lookup order: the provider's environment variable (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`), then the OS keychain through `@napi-rs/keyring` (service `katalepsis`, account = provider). With `CI` set, the keychain is never read.
- `auth set` reads the key without echo, or from piped stdin, and writes it only to the keychain. `auth status` prints only the source. `auth forget` deletes the entry.
- Provider and model live in `config.json` under `$KATALEPSIS_HOME`, `$XDG_CONFIG_HOME/katalepsis` or `~/.config/katalepsis`, with directory mode 0700 and file mode 0600. The schema has no field that could hold a key.
- Choice order: `--provider`/`--model`, then `KATALEPSIS_PROVIDER`/`KATALEPSIS_MODEL`, then the saved preferences. There is no default model.
- Before any check runs, the model ID is checked against the provider's catalog. OpenRouter's catalog is public, so its key is also checked against `GET /api/v1/key`. A missing key, rejected key or unknown model blocks every check with a `credentials` or `configuration` error.
- Keys are held as Effect `Redacted` values. The key and the preview URL's query values are redacted from every text file in the bundle before it is written.
- Providers: OpenAI (`@ai-sdk/openai`) and OpenRouter (`@openrouter/ai-sdk-provider`). Adding one means a branch in `createModel` and a catalog URL in `validateModel`.

### 4. Browser adapter

M2 drives Chromium directly through `playwright-core`, not through Playwright MCP. The plan allows either; the library avoids a second process and gives exact control over assertions, tracing and navigation blocking. A Playwright MCP adapter can sit behind the same `CheckSession` interface later if a need appears.

### 5. Coding agents (M3 direction)

Claude Code, Codex and similar tools should drive katalepsis through its own MCP server (M3), calling high-level tools whose results go through the same `decideOutcome` rules. A coding agent then gets the same guarantee as the built-in loop: it can choose actions, but it cannot declare a pass without a passing browser assertion. The BYOK loop stays for CI, where no coding agent runs.

## Consequences

- An agent check costs model tokens; Playwright runs (M1) still need no key.
- A check whose pass condition cannot be expressed as visible, hidden or URL assertions will end blocked, not passed.
- Live runs vary between models and between runs. The fake-model tests pin the decision rules; the live smoke test (`pnpm test:live`) checks the demo end to end with a real model.
