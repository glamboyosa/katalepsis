# Reference review: Docket and Conclave

This review records how two existing projects handle provider credentials and model selection. katalepsis does not implement credentials until M2. This file exists so M2 starts from verified source, not from README claims.

Reviewed on 2026-10-10 from local clones. Both clones matched `git ls-remote origin HEAD` on that date.

| Repository                                                    | Commit                                     |
| ------------------------------------------------------------- | ------------------------------------------ |
| [glamboyosa/docket](https://github.com/glamboyosa/docket)     | `de6b8834ac1c99cff37d0896db6ba47e5ec821aa` |
| [glamboyosa/conclave](https://github.com/glamboyosa/conclave) | `9fb6fc0ddcfabb7522d5fe1a5cf495ec627c736a` |

No keys or private configuration were copied. One local `.env` file exists in these working trees, and it was not opened.

## Docket (Go CLI)

### Credential lookup order

`internal/config/secrets.go`

1. An unknown provider is an error (line 22).
2. The environment variable wins when it is non-empty after trimming (line 24). The names are `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY` and `OPENAI_API_KEY` (lines 11-15).
3. Otherwise the OS keychain is read with `keyring.Get("docket", provider)` (line 27).
4. A missing value returns `"<ENV> is not configured; run docket auth set <provider>"` (line 29).

No config file or flag is consulted for keys. Keys from the environment are never copied into the keychain.

### Keychain and `auth` commands

- Library: `github.com/zalando/go-keyring v0.2.6` (`go.mod:8`). The service is `docket` (`internal/config/config.go:11`) and the account is the provider name.
- `auth set <provider>` writes a prompt to stderr and reads the key without echo through `term.ReadPassword` (`cmd/docket/main.go:192`). It needs a TTY and has no piped or flag input.
- `auth status` prints each provider with its source: the env var name, `keychain`, `missing` or `unknown` (`secrets.go:55-67`, `main.go:178-182`). It never prints the value.
- `auth forget <provider>` deletes the keychain entry and treats "not found" as success (`secrets.go:44-53`).

### Preferences

- `Config{Provider, Model, LibraryPath}` has no key fields (`config.go:13-17`).
- Stored at `$DOCKET_HOME/config.json` or `os.UserConfigDir()/docket/config.json` (`config.go:31-40`).
- Directory mode `0700`, file mode `0600` (`config.go:82`, `config.go:89`).
- Model selection: `docket models [provider]` lists models; `docket config model <id>` saves any string without checking it against the catalog (`main.go:222-223`).
- Catalogs come from Models.dev plus the provider's own `/models` endpoint, with a 10 s timeout (`internal/provider/catalog.go`).

### Redaction

Docket has no explicit redaction. Keys only appear in `Authorization` headers. Error paths include up to 4 KB of the provider's response body (`internal/provider/extractor.go:238-240`, `internal/provider/jev.go:111-113`), which is printed to stderr. Whether a provider could echo request data there is an inference, not something observed.

## Conclave (TypeScript web app)

### Provider construction

`server/provider-models.ts`

- 14 provider values, including `openrouter`, `openai`, `anthropic`, `google`, `ollama`, `lmstudio`, `custom` and an offline `demo` mode (lines 19-39). Length caps: model 200, base URL 500, key 1000.
- `buildModel` (lines 255-349) uses `createOpenRouter` from `@openrouter/ai-sdk-provider`, `create<Provider>` from each `@ai-sdk/*` package, and `createOpenAICompatible` for local and custom endpoints.
- `requireKey` (lines 119-130) only checks that a trimmed key is present. Key format is not validated.
- The server's shared `OPENROUTER_API_KEY` is used only for free `nvidia/*:free` models (`src/providers.ts:363-369`).

### Endpoint checks

`compatibleBaseURL` (lines 93-117) rejects credentials, query, hash and non-http(s) protocols. Loopback means only `localhost` or `127.0.0.1`; `[::1]` is not treated as loopback. Custom endpoints need https unless loopback. There is no private-IP, metadata-IP, DNS or redirect check.

### Request handling and redaction

`server/api.ts`, `server/run-error.ts`

- Keys arrive in the `x-conclave-key` header for `GET /api/models` (lines 138-141) and in the JSON body for `POST /api/run` and `/api/discuss`. Never in a URL.
- `redactSecrets` (`run-error.ts:3-13`) replaces each secret, its trimmed form and its `encodeURIComponent` form with `[redacted]`, then applies `/Bearer\s+\S+|sk-[\w-]+/gi`, then truncates to 600 characters.
- `describeRunError` (lines 15-50) only returns redacted `APICallError` text to the client, with advice by status: 401/403 key, 402 billing, 429/5xx retry, 404 model. Everything else gets a generic message.
- The model name is redacted too (`api.ts:231`, `api.ts:365`).
- Catalog errors in `/api/models` are swallowed and return a fallback list with HTTP 200 (lines 175-184). A bad key looks like a fallback.

### Frontend

- Keys live only in React state (`src/App.tsx:239`, `281-288`). A restored connection always has `apiKey: ""` (`App.tsx:105-128`).
- `localStorage["conclave:connection"]` holds `{provider, model, baseURL}` and no key. `persistableEndpoint` drops URLs with credentials, query or hash (`src/providers.ts:388-407`).
- Exports (`src/storage.ts:119-135`) contain no key or base URL. Analytics drop everything except page views (`src/analytics.ts:3-8`).

### Versions

`ai` 7.0.97, `@ai-sdk/openai` 4.0.65, `@ai-sdk/openai-compatible` 3.0.47, `@openrouter/ai-sdk-provider` 3.0.0, `zod` 4.1.12. Conclave does not depend on Effect.

## Current package versions checked for katalepsis

Checked on npm on 2026-10-10.

| Package                       | Version            | Status                                                                                                                                                                                                                                  |
| ----------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effect`                      | 4.0.2              | Installed. APIs used were read from the installed type declarations: `Context.Service`, `Layer.succeed`, `Schema.Struct`, `Schema.decodeUnknownEffect`, `Effect.callback`, `Effect.timeoutOrElse`, `Effect.result`, `Data.TaggedError`. |
| `@playwright/test`            | 1.63.0 in the demo | Installed in `apps/demo-form` only. The JSON reporter shape was captured from a real run (`packages/core/test/fixtures/signup-report.json`). 1.64.0 is the latest release but needs a browser build that is not on this machine.        |
| `typescript`                  | 7.0.2              | Installed.                                                                                                                                                                                                                              |
| `vitest`                      | 5.0.3              | Installed. Its engines field is `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0`.                                                                                                                                                                  |
| `oxlint` / `oxfmt`            | 1.87.0 / 0.72.0    | Installed.                                                                                                                                                                                                                              |
| `ai`                          | 7.0.137            | Installed in M2 (`packages/agent`). `ToolLoopAgent`, `tool`, `isStepCount`, `hasToolCall` and `ai/test` mocks were checked against the bundled docs.                                                                                    |
| `@ai-sdk/openai`              | 4.0.91             | Installed in M2.                                                                                                                                                                                                                        |
| `@openrouter/ai-sdk-provider` | 3.1.0              | Installed in M2.                                                                                                                                                                                                                        |
| `@modelcontextprotocol/sdk`   | 1.32.1             | Not installed. M3.                                                                                                                                                                                                                      |
| `@napi-rs/keyring`            | 2.1.0              | Installed in M2 (`packages/credentials`) for the OS keychain. Tested on macOS only.                                                                                                                                                     |

## Decisions for katalepsis

1. **CLI and MCP credentials follow Docket's order**: environment variable first, then OS keychain, then `missing`. Keys are never written to the preferences file, the report bundle or logs.
2. **`auth status` reports only the source** (`environment`, `keychain`, `missing`), as Docket does.
3. **Preferences use Docket's file modes**: directory `0700`, file `0600`.
4. **Conclave's tab-memory model is not reused.** It fits a browser tab, not a CLI. katalepsis has no browser UI that accepts keys.
5. **Redaction follows Conclave's approach and goes further.** katalepsis redacts exact values and their URL-encoded forms before anything is written. It also redacts preview URL query values, because preview hosts put bypass tokens there. In M2 the resolved provider key is redacted by exact value, which covers keys of any format; no `sk-` or `Bearer` pattern is needed.
6. **Model IDs will be checked against the provider catalog** in M2. Docket saves any string, so a typo only fails at run time. katalepsis will record the model in the report.
7. **Provider errors will not be swallowed.** Conclave returns a fallback catalog on a bad key. katalepsis will report `credentials` as a typed run error.
8. **Endpoint checks are stricter than Conclave's** when M2 adds custom endpoints: treat `::1` as loopback, and add private-range checks before any hosted mode.

## Unverified assumptions

- Keychain behaviour on Linux and Windows depends on the library chosen in M2 and has not been tested.
- What the Langfuse AI SDK integration in Conclave records beyond the explicit metadata was not checked.
- The demo uses Playwright 1.63. Other Playwright versions are expected to produce the same JSON fields; the decoder rejects reports that do not match, rather than guessing.
