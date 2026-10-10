# Using katalepsis from Claude Code, Codex or Cursor

katalepsis ships a local MCP server. A coding agent can run your Playwright tests against a preview, run agent checks, and read reports, without you typing CLI commands. The same rules apply as on the command line: a check passes only on browser evidence, and the server never takes an API key as an argument.

## What the agent gets

| Tool                         | What it does                                                                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verification_run_tests`     | Runs the project's Playwright tests against `baseUrl`. Optional `cwd`, `project`, `grep`, `timeoutSeconds`. No AI key needed.                                                |
| `verification_check_browser` | Runs agent checks (`id`, `name`, `intent`, `passCondition`) against `baseUrl` with your locally configured provider and model. Optional `provider`, `model`, `allowOrigins`. |
| `verification_get_report`    | Reads an earlier run by `runId`, as a summary, the Markdown report or the manifest.                                                                                          |

Each run tool returns the run ID, status, counts, every check's result, what wasn't tested, and the paths to `report.html`, `report.md` and `manifest.json`.

The server:

- only works inside the directory you give it with `--root`; a `cwd` outside it is refused,
- runs one verification at a time and turns away a second one until the first finishes,
- reads keys from the environment or the OS keychain, exactly like the CLI, and never accepts them as tool arguments.

## Before you connect it

Build katalepsis once, and set up a key and model if you want agent checks:

```bash
pnpm install && pnpm build
node packages/cli/dist/main.js auth set openrouter
node packages/cli/dist/main.js config provider openrouter
node packages/cli/dist/main.js config model <model-id>
```

In the commands below, replace `/path/to/katalepsis` with your clone and `/path/to/your-app` with the project whose tests and previews you want checked.

Runs can take minutes. Codex and Claude Code have a tool timeout, and the examples raise it to 10 minutes. The server stops a test run after 9 minutes by default, so it reports before the client gives up; pass `timeoutSeconds` to change that. Agent checks also stop after 9 minutes in total, and any checks not reached are reported as not run.

## Codex

Tested with Codex CLI 0.160.0. From `codex exec`, Codex ran the demo's tests (2 passed, 1 failed), ran agent checks with OpenRouter, and read a report back with `verification_get_report`.

```bash
codex mcp add katalepsis -- node /path/to/katalepsis/packages/mcp/dist/main.js --root /path/to/your-app
```

Then raise the tool timeout in `~/.codex/config.toml`. Codex waits 60 seconds by default, which is not enough for a test run:

```toml
[mcp_servers.katalepsis]
command = "node"
args = ["/path/to/katalepsis/packages/mcp/dist/main.js", "--root", "/path/to/your-app"]
tool_timeout_sec = 600
# Only needed if your key is in an environment variable rather than the keychain.
env_vars = ["OPENROUTER_API_KEY"]
```

Codex does not pass your shell's environment to MCP servers unless you list variables in `env_vars`. A key saved with `katalepsis auth set` is read from the keychain and needs nothing here.

To try it without editing your config, pass the same settings as flags:

```bash
codex exec \
  -c 'mcp_servers.katalepsis.command="node"' \
  -c 'mcp_servers.katalepsis.args=["/path/to/katalepsis/packages/mcp/dist/main.js","--root","/path/to/your-app"]' \
  -c 'mcp_servers.katalepsis.tool_timeout_sec=600' \
  "Run verification_run_tests against https://your-preview.example.com and summarise the failures"
```

Codex's `--sandbox` setting applies to commands Codex runs, not to MCP servers. The katalepsis server writes reports into `artifacts/katalepsis/` under the project either way.

## Claude Code

Not tested here, because the Claude Code CLI was not installed. The commands follow Anthropic's MCP documentation and the same shape Playwright MCP publishes for Claude Code.

```bash
claude mcp add katalepsis -- node /path/to/katalepsis/packages/mcp/dist/main.js --root /path/to/your-app
claude mcp list
```

Or add `.mcp.json` at the project root. The `timeout` field is in milliseconds and gives each tool call up to 10 minutes. Without `--root`, the server uses `CLAUDE_PROJECT_DIR`, which Claude Code sets to the project it has open. The path to katalepsis is specific to your machine, so keep this file out of version control, or use the `claude mcp add` command above instead:

```json
{
  "mcpServers": {
    "katalepsis": {
      "command": "node",
      "args": ["/path/to/katalepsis/packages/mcp/dist/main.js"],
      "timeout": 600000
    }
  }
}
```

Claude Code asks before it uses servers from a project's `.mcp.json`. Inside a session, `/mcp` shows whether katalepsis connected.

## Cursor

Not tested here. Add `.cursor/mcp.json` to the project, or `~/.cursor/mcp.json` for every project. Cursor's documentation does not describe a tool timeout setting:

```json
{
  "mcpServers": {
    "katalepsis": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/katalepsis/packages/mcp/dist/main.js", "--root", "/path/to/your-app"]
    }
  }
}
```

## Check it works without an agent

`pnpm mcp:demo <preview-url> [project-dir]` starts the server, lists its tools, runs the tests and reads the report back, the same calls an agent makes:

```bash
pnpm --filter demo-form serve
pnpm mcp:demo http://127.0.0.1:4173 apps/demo-form
```
