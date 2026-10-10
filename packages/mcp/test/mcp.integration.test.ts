import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const serverMain = path.join(repoRoot, "packages/mcp/dist/main.js");
const demo = path.join(repoRoot, "apps/demo-form");

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port")),
      );
    });
  });

/** PIDs of Playwright-managed browsers, which run from the ms-playwright cache. */
const browserProcesses = (): Set<string> => {
  try {
    return new Set(execFileSync("pgrep", ["-f", "ms-playwright"], { encoding: "utf8" }).trim().split("\n"));
  } catch {
    return new Set();
  }
};

const leftoverBrowsers = async (baseline: ReadonlySet<string>): Promise<Array<string>> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ([...browserProcesses()].every((pid) => baseline.has(pid))) return [];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return [...browserProcesses()].filter((pid) => !baseline.has(pid));
};

const connect = async (root: string, home: string): Promise<Client> => {
  const created = new Client({ name: "katalepsis-test-client", version: "0.0.0" });
  await created.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverMain, "--root", root],
      env: { ...safeEnv(), KATALEPSIS_HOME: home },
      stderr: "pipe",
    }),
  );
  return created;
};

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, any>;
};

/** The real environment minus anything that would pick a model or supply a key. */
const safeEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !/^(OPENAI_API_KEY|OPENROUTER_API_KEY|KATALEPSIS_.*)$/.test(entry[0]),
    ),
  );

let demoServer: ChildProcess;
let baseUrl: string;
let home: string;
let client: Client;

const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
  (await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as ToolResult;

beforeAll(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}/`;
  demoServer = spawn(process.execPath, [path.join(demo, "server.mjs")], {
    env: { ...process.env, PORT: String(port) },
    stdio: "pipe",
  });
  await new Promise<void>((resolve) => demoServer.stdout?.once("data", () => resolve()));

  // No saved provider or model and no key variables, so agent checks must say what is missing.
  home = await mkdtemp(path.join(tmpdir(), "katalepsis-mcp-home-"));
  client = await connect(demo, home);
});

afterAll(async () => {
  await client.close();
  demoServer.kill();
  await rm(home, { recursive: true, force: true });
  await rm(path.join(demo, "artifacts"), { recursive: true, force: true });
});

describe("katalepsis MCP server", () => {
  it("lists three high-level tools with object input schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "verification_run_tests",
      "verification_check_browser",
      "verification_get_report",
    ]);
    for (const tool of tools) expect(tool.inputSchema.type).toBe("object");
  });

  it("runs the demo's Playwright tests and reads the report back", async () => {
    const result = await call("verification_run_tests", { baseUrl });
    expect(result.isError).toBeUndefined();
    const summary = result.structuredContent ?? {};
    expect(summary["status"]).toBe("failed");
    expect(summary["counts"]).toEqual({ passed: 2, failed: 1, blocked: 0, notTested: 0 });
    expect(existsSync(summary["report"].html)).toBe(true);

    const markdown = await call("verification_get_report", { runId: summary["runId"], format: "markdown" });
    expect(markdown.content[0]?.text).toContain("**2 passed, 1 failed, 0 blocked**");
    const again = await call("verification_get_report", { runId: summary["runId"] });
    expect(again.structuredContent?.["counts"]).toEqual(summary["counts"]);
  });

  it("blocks agent checks with a clear reason when no model is configured", async () => {
    const result = await call("verification_check_browser", {
      baseUrl,
      checks: [
        { id: "empty-form", name: "Empty form", intent: "Submit it empty", passCondition: "An error is visible" },
      ],
    });
    expect(result.structuredContent?.["status"]).toBe("blocked");
    expect(result.structuredContent?.["errors"]).toEqual([
      {
        category: "configuration",
        message: "No provider chosen. Run `katalepsis config provider <openai|openrouter>`.",
      },
    ]);
  });

  it("refuses a cwd outside the workspace root", async () => {
    const result = await call("verification_run_tests", { baseUrl, cwd: "../../.." });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("cwd must be inside the workspace root this server was started with.");
  });

  it("rejects invalid arguments without running anything", async () => {
    const result = await call("verification_get_report", { runId: "../../etc" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^Invalid arguments/);
  });

  it("runs one verification at a time", async () => {
    const first = call("verification_run_tests", { baseUrl });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = await call("verification_run_tests", { baseUrl });
    expect(second.isError).toBe(true);
    expect(second.content[0]?.text).toMatch(/^Another katalepsis run started \d+s ago and is still going/);
    expect((await first).structuredContent?.["status"]).toBe("failed");
  });

  it("rejects unknown arguments instead of ignoring them", async () => {
    const result = await call("verification_run_tests", { baseUrl, apiKey: "sk-should-not-be-here" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^Invalid arguments/);
    expect(result.content[0]?.text).not.toContain("sk-should-not-be-here");
  });

  it("rejects agent checks with duplicate IDs", async () => {
    const check = { id: "same", name: "A", intent: "Do it", passCondition: "It is visible" };
    const result = await call("verification_check_browser", { baseUrl, checks: [check, check] });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("used more than once");
  });

  it("stops a run the client cancels and still writes a blocked report", async () => {
    const controller = new AbortController();
    const pending = client.callTool({ name: "verification_run_tests", arguments: { baseUrl } }, undefined, {
      signal: controller.signal,
      timeout: 120_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
    // Give the cancelled run time to stop Playwright and write its report.
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const reports = await readdir(path.join(demo, "artifacts", "katalepsis"));
    const manifests = await Promise.all(
      reports.map(async (id) =>
        JSON.parse(await readFile(path.join(demo, "artifacts", "katalepsis", id, "manifest.json"), "utf8")),
      ),
    );
    expect(
      manifests.some((run) => run.errors.some((error: { message: string }) => error.message.includes("cancelled"))),
    ).toBe(true);
  });
});

describe("katalepsis MCP server containment", () => {
  it("will not read a report file that links outside the project", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "katalepsis-mcp-root-"));
    const runId = "2026-01-01T00-00-00-000Z-abcdef";
    const bundle = path.join(project, "artifacts", "katalepsis", runId);
    await mkdir(bundle, { recursive: true });
    const outside = path.join(home, "secret.txt");
    await writeFile(outside, "do not leak this");
    const manifest = JSON.parse(
      await readFile(
        path.join(
          demo,
          "artifacts",
          "katalepsis",
          (await readdir(path.join(demo, "artifacts", "katalepsis")))[0] ?? "",
          "manifest.json",
        ),
        "utf8",
      ),
    );
    await writeFile(path.join(bundle, "manifest.json"), JSON.stringify({ ...manifest, id: runId }));
    await symlink(outside, path.join(bundle, "report.md"));

    const contained = await connect(project, home);
    const result = (await contained.callTool({
      name: "verification_get_report",
      arguments: { runId, format: "markdown" },
    })) as ToolResult;
    await contained.close();
    await rm(project, { recursive: true, force: true });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("do not leak this");
  });

  it("refuses to use an artifacts folder that is a link", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "katalepsis-mcp-root-"));
    await symlink(home, path.join(project, "artifacts"));
    const contained = await connect(project, home);
    const result = (await contained.callTool({
      name: "verification_get_report",
      arguments: { runId: "2026-01-01T00-00-00-000Z-abcdef" },
    })) as ToolResult;
    await contained.close();
    await rm(project, { recursive: true, force: true });
    expect(result.content[0]?.text).toBe("artifacts must be a real directory, not a link or a file.");
  });

  it("stops Playwright and its browsers when the client quits mid-run", async () => {
    const baseline = browserProcesses();
    const reports = path.join(demo, "artifacts", "katalepsis");
    const before = new Set(await readdir(reports).catch(() => []));
    const quitting = await connect(demo, home);
    void quitting.callTool({ name: "verification_run_tests", arguments: { baseUrl } }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await quitting.close();
    expect(await leftoverBrowsers(baseline)).toEqual([]);

    // The run was cut short, but it still left a blocked report saying so.
    const created = (await readdir(reports)).filter((id) => !before.has(id));
    expect(created).toHaveLength(1);
    let manifestText = "";
    for (let attempt = 0; attempt < 50 && manifestText === ""; attempt += 1) {
      manifestText = await readFile(path.join(reports, created[0] ?? "", "manifest.json"), "utf8").catch(() => "");
      if (manifestText === "") await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const manifest = JSON.parse(manifestText);
    expect(manifest.status).toBe("blocked");
    expect(JSON.stringify(manifest.errors)).toContain("cancelled");
  });
});
