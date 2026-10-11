# Installing katalepsis: instructions for coding agents

You are a coding agent, and your user wants katalepsis set up. Follow these steps in order. Run the commands yourself, except where a step says the user must do it.

katalepsis is a command-line tool and a local MCP server. It runs a project's Playwright tests, or plain-English checks driven by a model, against a preview deployment and writes a report. Every check ends up passed, failed, blocked or not tested. Source and full docs: https://github.com/glamboyosa/katalepsis

## 1. Check the prerequisites

```bash
node --version
git --version
pnpm --version || corepack --version
```

You need Node 22.12 or newer, git, and either pnpm 10 or corepack (corepack ships with Node). If Node is older or missing, stop and tell the user. Do not upgrade Node yourself.

## 2. Run the installer

katalepsis is not on npm. The installer clones the repository into `~/.local/share/katalepsis`, builds it, and writes two launchers, `katalepsis` and `katalepsis-mcp`, into `~/.local/bin`. It never asks for input.

```bash
curl -fsSL https://www.katalepsis.glamboyosa.xyz/install.sh | sh
```

It prints `Installed katalepsis <version> to <dir>` on success. If it also prints that `~/.local/bin` is not on `PATH`, call the tools by full path (`~/.local/bin/katalepsis`) for the rest of this guide, and tell the user to add the `export PATH=...` line it printed to their shell profile. Do not edit their shell profile yourself.

Confirm it worked:

```bash
katalepsis --version
```

## 3. Prepare the project

If the project has Playwright tests, run this. It checks that `@playwright/test` and a `playwright.config.*` file exist, then adds `artifacts/katalepsis/` to the project's `.gitignore`:

```bash
katalepsis init --cwd <project-dir>
```

`init` exits with code 3 when Playwright or its config is missing, and then leaves `.gitignore` alone. For a project without Playwright, skip `init` and add `artifacts/katalepsis/` to its `.gitignore` yourself, so reports are not committed.

If the project has Playwright tests, its Playwright config must read the preview URL from `KATALEPSIS_BASE_URL` and keep failure evidence. Edit the `use` block of the existing config (usually `playwright.config.ts`) so it contains:

```ts
use: {
  baseURL: process.env.KATALEPSIS_BASE_URL ?? "http://localhost:3000",
  screenshot: "only-on-failure",
  video: "retain-on-failure",
  trace: "retain-on-failure",
},
```

Keep the project's current `baseURL` value as the fallback instead of `http://localhost:3000`. Show the user this change.

If the project has no Playwright tests, skip the config change. The user can still use agent checks (step 5).

## 4. Connect the MCP server to your harness

The MCP server gives you three tools: `verification_run_tests`, `verification_check_browser` and `verification_get_report`. Runs can take minutes, so raise the tool timeout to 10 minutes where your harness allows it. Set it up for the harness you are running in:

Claude Code:

```bash
claude mcp add katalepsis -- katalepsis-mcp --root <project-dir>
```

Or add `.mcp.json` at the project root. Without `--root`, the server uses the project Claude Code has open:

```json
{
  "mcpServers": {
    "katalepsis": {
      "command": "katalepsis-mcp",
      "timeout": 600000
    }
  }
}
```

Codex:

```bash
codex mcp add katalepsis -- katalepsis-mcp --root <project-dir>
```

Then set `tool_timeout_sec = 600` under `[mcp_servers.katalepsis]` in `~/.codex/config.toml`, because Codex waits 60 seconds by default. `codex exec` refuses tool calls that need approval, so non-interactive use also needs `default_tools_approval_mode = "approve"`, and a key kept in an environment variable needs `env_vars = ["OPENROUTER_API_KEY"]`. Both are explained in the [Codex section of the MCP docs](https://github.com/glamboyosa/katalepsis/blob/main/docs/mcp.md#codex).

Cursor: add `.cursor/mcp.json` to the project:

```json
{
  "mcpServers": {
    "katalepsis": {
      "type": "stdio",
      "command": "katalepsis-mcp",
      "args": ["--root", "<project-dir>"]
    }
  }
}
```

Any other harness: register a stdio MCP server with the command `katalepsis-mcp` and the arguments `--root <project-dir>`.

If the harness can't find `katalepsis-mcp`, because it starts servers without the shell's `PATH`, use the full path, such as `/Users/<name>/.local/bin/katalepsis-mcp`. Most harnesses load new MCP servers only in a new session, so tell the user to restart it.

More detail, including what was tested with each harness: https://github.com/glamboyosa/katalepsis/blob/main/docs/mcp.md

## 5. Agent checks need a key, and the user must enter it

Running the project's Playwright tests needs no AI key. Agent checks (`katalepsis verify` and `verification_check_browser`) need an OpenAI or OpenRouter key.

Never ask the user to paste a key into the chat, never put a key in a command, a file or an MCP argument, and never read one back. Ask the user to run this themselves in their own terminal. It reads the key without echoing it and stores it in the OS keychain:

```bash
katalepsis auth set openrouter
```

Once they have, you can choose the provider and model:

```bash
katalepsis config provider openrouter
katalepsis models openrouter
katalepsis config model <model-id>
```

Pick a model ID from the `models` output. Do not guess one.

## 6. Check it works

If the project has Playwright tests and the user has a preview URL, or a local server is running, run the tests against it:

```bash
katalepsis run --cwd <project-dir> --url <preview-url> --install-browsers
```

`--install-browsers` runs the project's own `playwright install` first, which can download about 1 GB the first time. Ask the user before you use it.

The command prints the result and the path to `report.md`. Exit code 0 means every check that ran passed, 1 means a check failed, 2 means the run was blocked (preview down, browser missing or nothing ran), 3 means a usage or setup error, and 4 means the report couldn't be written.

For a project with agent checks only, check the setup with `katalepsis verify --cwd <project-dir> --url <preview-url> --checks <checks.json>` instead, once the user has saved a key. A checks file lists checks with an `id`, `name`, `intent` and `passCondition`; the README has an example.

## What the install touches

- `~/.local/share/katalepsis` (source and build) and `~/.local/bin/katalepsis`, `~/.local/bin/katalepsis-mcp`
- `~/.config/katalepsis/config.json` for the provider and model, never a key
- The OS keychain, under the service name `katalepsis`, only if the user runs `katalepsis auth set`
- Reports in `artifacts/katalepsis/<run-id>/` inside the checked project

To uninstall: `katalepsis auth forget <provider>` for each saved provider, then delete `~/.config/katalepsis`, `~/.local/share/katalepsis` and the two launchers.
