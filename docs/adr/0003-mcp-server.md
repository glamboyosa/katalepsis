# ADR 0003: Local MCP server

- Status: accepted for M3
- Date: 2026-10-10

## Context

Coding agents such as Claude Code, Codex and Cursor should be able to verify a preview and read the result without someone running the CLI. The plan asks for a stdio server exposing katalepsis's own operations, not raw browser control.

## Decisions

1. **Three tools.** `verification_run_tests`, `verification_check_browser` and `verification_get_report`, matching the plan. They call the same `verifyWithPlaywright` and `verifyWithAgent` workflows as the CLI and write the same bundle to `artifacts/katalepsis/` under the project. An agent gets no browser tools, so it cannot drive the page outside the evidence rules in ADR 0002.
2. **One workspace root.** The server takes `--root` (default: `CLAUDE_PROJECT_DIR` when Claude Code sets it, otherwise its working directory) and resolves every `cwd` with `realpath`. Anything outside the root, symlinks included, is refused. `verification_get_report` only reads `artifacts/katalepsis/<runId>/` and validates `runId` against the run ID format.
3. **One run at a time.** A second run tool call while one is in progress gets an error telling the agent to wait. Reading reports is always allowed.
4. **No keys in arguments.** Agent checks call the CLI's model setup (`setupLocalModel`): flags for provider and model, then `KATALEPSIS_PROVIDER`/`KATALEPSIS_MODEL`, then saved preferences, and the key from the environment or the keychain. Tool schemas have no key field.
5. **Effect Schema for inputs.** The SDK's high-level `McpServer` only accepts zod schemas. The server uses the SDK's lower-level `Server` instead, publishes JSON Schemas generated from Effect Schema, and validates arguments with the same schemas. Optional fields use exact optional keys so the published schema never invites `null`.
6. **Results.** Each run returns structured content (status, counts, every check, not-tested items, run errors and report paths) plus the same JSON as text for clients that ignore structured content. Errors are short messages without stack traces.
7. **Cancellation and shutdown.** The request's abort signal is passed to the workflows, so a client that cancels a call stops Playwright or the agent the same way Ctrl-C does in the CLI. When the client goes away (stdin closes, or SIGTERM, SIGINT or SIGHUP arrives), the server kills Playwright's process group, closes the MCP connection, which aborts the run in progress, waits for that run to write its blocked report, and exits. A second signal exits at once.
8. **No links out of the project.** Neither `artifacts` nor `artifacts/katalepsis` may be a symlink, and report files are read only if they are regular files, so a crafted project cannot make `verification_get_report` read files elsewhere.
9. **Strict arguments.** Unknown argument keys are rejected and the published schemas set `additionalProperties: false`, so a stray field such as an API key is refused rather than silently ignored. Arguments are checked before the run lock, so a bad call is answered at once. Formats the JSON Schema cannot carry, such as check IDs, are stated in the tool descriptions.
10. **Run time.** A test run stops after 540 seconds by default, and an agent run stops after 540 seconds in total, both below the 600-second client timeout the setup guide recommends.

## Consequences

- Clients must allow long tool calls. Codex's default is 60 seconds; the setup guide raises it to 600.
- Codex only forwards environment variables listed in `env_vars`, so keys in the environment need that setting. Keys in the keychain work everywhere.
- Codex's sandbox does not cover MCP servers; the server writes reports regardless of `--sandbox`.
