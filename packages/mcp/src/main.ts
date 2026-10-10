#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { forceStopPlaywright } from "@katalepsis/core";
import { createServer } from "./server.ts";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const { values } = parseArgs({ options: { root: { type: "string" } } });

// stdout carries the MCP protocol, so anything for humans goes to stderr.
// Claude Code sets CLAUDE_PROJECT_DIR for the servers it starts, so .mcp.json needs no --root.
const root = realpathSync(path.resolve(values.root ?? process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd()));
const { server, idle } = createServer({ root, version, env: process.env });

let shuttingDown = false;
let signals = 0;
/**
 * Stops cleanly when the client goes away. Playwright's process group is killed outright,
 * then closing the server aborts the run in progress, which writes a blocked report, and
 * the process exits once that run has finished cleaning up.
 */
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  forceStopPlaywright();
  await server.close();
  await idle();
  process.exit(0);
};
// Clients close stdin and then send SIGTERM a moment later, so only a second signal skips
// the cleanup.
const onSignal = (): void => {
  signals += 1;
  if (signals > 1) {
    forceStopPlaywright();
    process.exit(1);
  }
  void shutdown();
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, onSignal);
process.stdin.on("end", () => void shutdown());
process.stdin.on("close", () => void shutdown());

await server.connect(new StdioServerTransport());
console.error(`katalepsis MCP server ${version} ready. Workspace root: ${root}`);
