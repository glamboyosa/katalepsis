// Calls the katalepsis MCP server the way a coding agent would, and prints each result.
// Usage: node packages/mcp/scripts/demo-client.mjs <preview-url> [project-dir]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const [baseUrl, projectDir = "apps/demo-form"] = process.argv.slice(2);
if (baseUrl === undefined)
  throw new Error("Usage: node packages/mcp/scripts/demo-client.mjs <preview-url> [project-dir]");
const serverMain = fileURLToPath(new URL("../dist/main.js", import.meta.url));

const client = new Client({ name: "katalepsis-demo-client", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [serverMain, "--root", path.resolve(projectDir)] }),
);

const { tools } = await client.listTools();
console.log("Tools:", tools.map((tool) => tool.name).join(", "));

const run = await client.callTool({ name: "verification_run_tests", arguments: { baseUrl } }, undefined, {
  timeout: 600_000,
});
console.log("\nverification_run_tests:\n" + run.content[0].text);

const runId = run.structuredContent?.runId;
if (typeof runId === "string") {
  const report = await client.callTool({ name: "verification_get_report", arguments: { runId, format: "markdown" } });
  console.log("\nverification_get_report (markdown):\n" + report.content[0].text);
}
await client.close();
