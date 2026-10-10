# Contributing

## Setup

```bash
pnpm install
pnpm build
```

The demo app pins `@playwright/test` 1.63.0. If its browser is missing, run `pnpm --filter demo-form exec playwright install chromium`.

## Checks

| Command                 | What it runs                                                              |
| ----------------------- | ------------------------------------------------------------------------- |
| `pnpm format`           | Formats with oxfmt                                                        |
| `pnpm format:check`     | Fails on unformatted files                                                |
| `pnpm lint`             | oxlint, warnings are errors                                               |
| `pnpm typecheck`        | TypeScript for packages, tests and the demo                               |
| `pnpm test`             | Unit tests                                                                |
| `pnpm test:integration` | Builds, starts the demo server on a free port and runs the CLI end to end |
| `pnpm check`            | format check, lint, typecheck and unit tests                              |

Run `pnpm check` and `pnpm test:integration` before opening a pull request. Neither needs an API key: agent tests use a scripted fake model in a real browser.

`pnpm test:live` runs the demo checks against a real model and spends a little of your own credit. It reads `.env.local` if present and needs `KATALEPSIS_PROVIDER`, `KATALEPSIS_MODEL` and that provider's key:

```bash
KATALEPSIS_PROVIDER=openrouter KATALEPSIS_MODEL=<model-id> pnpm test:live
```

## Layout

```text
packages/core         schemas, Playwright runner and report ingest, evidence store, renderers, verification workflow
packages/credentials  provider keys (environment, then OS keychain) and non-secret preferences
packages/agent        agent checks: browser tools, assertion-based outcomes, AI SDK models
packages/mcp          the stdio MCP server for coding agents
packages/cli          the katalepsis command
apps/demo-form  a signup form with a deliberate bug and three Playwright tests
docs/           reference review and ADRs
```

`core` must not import from `cli`. Start new code in `core` and extract a package only when a boundary is real.

## Rules

- Playwright decides pass and fail. Do not add logic that turns a failed or skipped test into a pass.
- Tests assert observable results. Use the fakes in `packages/core/test/verify.test.ts` for orchestration and a local fixture for anything that needs a browser. Do not test against public sites.
- Nothing secret may reach the report bundle. Redact before writing, not when displaying.
- Escape all text from tests and pages in HTML and Markdown output.
- Keep `IMPLEMENTATION_STATUS.md` current when a milestone changes.
