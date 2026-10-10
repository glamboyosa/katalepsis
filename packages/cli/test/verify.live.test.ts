import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Spends a few cents of the caller's own credit. Runs only with KATALEPSIS_LIVE=1 and
// KATALEPSIS_PROVIDER, KATALEPSIS_MODEL and that provider's key set; see CONTRIBUTING.md.
const live = process.env["KATALEPSIS_LIVE"] === "1";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cli = path.join(repoRoot, "packages/cli/dist/main.js");
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

let server: ChildProcess;
let port: number;
let outDir: string;

beforeAll(async () => {
  if (!live) return;
  port = await freePort();
  outDir = await mkdtemp(path.join(tmpdir(), "katalepsis-live-"));
  server = spawn(process.execPath, [path.join(demo, "server.mjs")], {
    env: { ...process.env, PORT: String(port) },
    stdio: "pipe",
  });
  await new Promise<void>((resolve) => server.stdout?.once("data", () => resolve()));
});

afterAll(async () => {
  if (!live) return;
  server.kill();
  await rm(outDir, { recursive: true, force: true });
});

describe.runIf(live)("katalepsis verify with a real model", () => {
  it("finds the demo form's bug: 2 passed and 1 failed, with no key in the bundle", async () => {
    const { code, stdout } = await new Promise<{ code: number; stdout: string }>((resolve) => {
      execFile(
        process.execPath,
        [
          cli,
          "verify",
          "--url",
          `http://127.0.0.1:${port}/`,
          "--checks",
          "checks.json",
          "--cwd",
          demo,
          "--out",
          outDir,
        ],
        { timeout: 300_000 },
        (error, out) => resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout: out }),
      );
    });
    const bundle = /Report: (.+)report\.html/.exec(stdout)?.[1];
    if (bundle === undefined) throw new Error(`No report path in output:\n${stdout}`);
    const manifest = JSON.parse(await readFile(path.join(bundle, "manifest.json"), "utf8"));
    expect(code).toBe(1);
    expect(manifest.checks.map((check: { id: string; status: string }) => [check.id, check.status])).toEqual([
      ["empty-form", "failed"],
      ["valid-submission", "passed"],
      ["invalid-email", "passed"],
    ]);
    const key = process.env["OPENAI_API_KEY"] ?? "";
    const routerKey = process.env["OPENROUTER_API_KEY"] ?? "";
    const text = JSON.stringify(manifest) + (await readFile(path.join(bundle, "report.md"), "utf8"));
    for (const secret of [key, routerKey].filter((value) => value.length > 0)) expect(text).not.toContain(secret);
  });
});
