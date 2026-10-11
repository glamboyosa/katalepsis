import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

const runCli = (
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { timeout: 110_000, env }, (error, stdout, stderr) => {
      resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
    });
  });

/** PIDs of Playwright-managed browsers and ffmpeg, which run from the ms-playwright cache. */
const browserProcesses = (): Set<string> => {
  try {
    return new Set(execFileSync("pgrep", ["-f", "ms-playwright"], { encoding: "utf8" }).trim().split("\n"));
  } catch {
    // pgrep exits 1 when nothing matches.
    return new Set();
  }
};

/** Waits briefly for browsers started after `baseline` to exit, then returns any that remain. */
const leftoverBrowsers = async (baseline: ReadonlySet<string>): Promise<Array<string>> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const leftovers = [...browserProcesses()].filter((pid) => !baseline.has(pid));
    if (leftovers.length === 0) return [];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return [...browserProcesses()].filter((pid) => !baseline.has(pid));
};

const bundleFrom = (stdout: string): string => {
  const match = /Report: (.+)report\.html/.exec(stdout);
  if (match?.[1] === undefined) throw new Error(`No report path in output:\n${stdout}`);
  return match[1];
};

let server: ChildProcess;
let port: number;
let outDir: string;

beforeAll(async () => {
  port = await freePort();
  outDir = await mkdtemp(path.join(tmpdir(), "katalepsis-cli-"));
  server = spawn(process.execPath, [path.join(demo, "server.mjs")], {
    env: { ...process.env, PORT: String(port) },
    stdio: "pipe",
  });
  await new Promise<void>((resolve) => server.stdout?.once("data", () => resolve()));
});

afterAll(async () => {
  server.kill();
  await rm(outDir, { recursive: true, force: true });
});

describe("katalepsis run against the demo signup form", () => {
  it("reports 2 passed and 1 failed with checksummed evidence and exits 1", async () => {
    const { code, stdout } = await runCli([
      "run",
      "--url",
      `http://127.0.0.1:${port}/`,
      "--cwd",
      demo,
      "--out",
      outDir,
    ]);

    expect(code).toBe(1);
    const bundle = bundleFrom(stdout);
    const manifest = JSON.parse(await readFile(path.join(bundle, "manifest.json"), "utf8"));
    expect(manifest.status).toBe("failed");
    expect(manifest.checks.map((check: { title: string; status: string }) => [check.title, check.status])).toEqual([
      ["empty submission shows a required-field error", "failed"],
      ["valid submission shows a confirmation", "passed"],
      ["malformed email shows an email error and does not submit", "passed"],
    ]);

    const failedEvidence = manifest.evidence.filter(
      (file: { checkId: string | null }) => file.checkId === manifest.checks[0].id,
    );
    expect(failedEvidence.map((file: { kind: string }) => file.kind).toSorted()).toEqual([
      "log",
      "screenshot",
      "trace",
      "video",
    ]);
    for (const file of manifest.evidence as Array<{ path: string; sha256: string; bytes: number }>) {
      const contents = await readFile(path.join(bundle, file.path));
      expect(contents.byteLength).toBe(file.bytes);
      expect(createHash("sha256").update(contents).digest("hex")).toBe(file.sha256);
    }

    const markdown = await readFile(path.join(bundle, "report.md"), "utf8");
    expect(markdown).toContain("**2 passed, 1 failed, 0 blocked**");
    const html = await readFile(path.join(bundle, "report.html"), "utf8");
    expect(html).toContain('<img src="evidence/');
  });

  it("blocks every check and exits 2 when the preview is not running", async () => {
    const closedPort = await freePort();
    const { code, stdout } = await runCli([
      "run",
      "--url",
      `http://127.0.0.1:${closedPort}/`,
      "--cwd",
      demo,
      "--out",
      outDir,
    ]);

    expect(code).toBe(2);
    const manifest = JSON.parse(await readFile(path.join(bundleFrom(stdout), "manifest.json"), "utf8"));
    expect(manifest.status).toBe("blocked");
    expect(manifest.checks.map((check: { status: string }) => check.status)).toEqual(["blocked", "blocked", "blocked"]);
  });

  it("finds the newest report with report open --print", async () => {
    const { code, stdout } = await runCli(["report", "open", "--out", outDir, "--print"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/report\.html$/);
  });

  it("exits 3 for an invalid preview URL", async () => {
    const { code, stderr } = await runCli(["run", "--url", "file:///etc/passwd", "--cwd", demo, "--out", outDir]);
    expect(code).toBe(3);
    expect(stderr).toContain("http or https");
  });

  it("resolves --config against --cwd", async () => {
    const { code } = await runCli([
      "run",
      "--url",
      `http://127.0.0.1:${port}/`,
      "--cwd",
      demo,
      "--config",
      "playwright.config.ts",
      "--out",
      outDir,
    ]);
    expect(code).toBe(1);
  });

  it("exits 3 when --config does not exist", async () => {
    const { code, stderr } = await runCli([
      "run",
      "--url",
      `http://127.0.0.1:${port}/`,
      "--cwd",
      demo,
      "--config",
      "missing.config.ts",
    ]);
    expect(code).toBe(3);
    expect(stderr).toContain("--config file not found");
  });

  it("exits 4 when the report cannot be written", async () => {
    const notADirectory = path.join(outDir, "a-file");
    await writeFile(notADirectory, "");
    const { code, stderr } = await runCli([
      "run",
      "--url",
      `http://127.0.0.1:${port}/`,
      "--cwd",
      demo,
      "--out",
      notADirectory,
    ]);
    expect(code).toBe(4);
    expect(stderr).toContain("Could not create");
  });

  it("blocks the run, keeps Playwright's log and leaves no browser running when it exceeds --timeout", async () => {
    const baseline = browserProcesses();
    const { code, stdout } = await runCli([
      "run",
      "--url",
      `http://127.0.0.1:${port}/`,
      "--cwd",
      demo,
      "--out",
      outDir,
      "--timeout",
      "1",
    ]);
    expect(code).toBe(2);
    const bundle = bundleFrom(stdout);
    const manifest = JSON.parse(await readFile(path.join(bundle, "manifest.json"), "utf8"));
    expect(manifest.errors[0].message).toContain("did not finish within 1s");
    expect(await readdir(path.join(bundle, "evidence", "run"))).toContain("playwright.log");
    expect(await leftoverBrowsers(baseline)).toEqual([]);
  });
});

describe("katalepsis settings and errors", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  beforeAll(async () => {
    home = await mkdtemp(path.join(tmpdir(), "katalepsis-home-"));
    const {
      ANTHROPIC_API_KEY: _anthropic,
      OPENAI_API_KEY: _openai,
      OPENROUTER_API_KEY: _openrouter,
      ...rest
    } = process.env;
    env = { ...rest, KATALEPSIS_HOME: home };
  });
  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("drops a saved model when the provider changes, since model IDs differ between providers", async () => {
    await runCli(["config", "provider", "openrouter"], env);
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify({ provider: "openrouter", model: "anthropic/claude-haiku-5.5" }),
    );
    expect((await runCli(["config", "provider", "openrouter"], env)).stdout).not.toContain("Cleared");

    const switched = await runCli(["config", "provider", "openai"], env);
    expect(switched.stdout).toContain("Cleared the openrouter model anthropic/claude-haiku-5.5");
    expect(JSON.parse(await readFile(path.join(home, "config.json"), "utf8"))).toEqual({ provider: "openai" });
  });

  it("warns when the Playwright config does not read KATALEPSIS_BASE_URL", async () => {
    await writeFile(
      path.join(home, "playwright.config.ts"),
      'export default { use: { baseURL: "http://localhost:3000" } };',
    );
    const { stderr } = await runCli(["run", "--url", "http://127.0.0.1:1/", "--cwd", home], env);
    expect(stderr).toContain("playwright.config.ts does not read KATALEPSIS_BASE_URL");

    const demoRun = await runCli(["run", "--url", "http://127.0.0.1:1/", "--cwd", demo, "--out", outDir], env);
    expect(demoRun.stderr).not.toContain("does not read KATALEPSIS_BASE_URL");
  });

  it("prints usage for a command-line mistake but not for other errors", async () => {
    const unknown = await runCli(["bogus"], env);
    expect(unknown.code).toBe(3);
    expect(unknown.stderr).toContain("Unknown command: bogus");
    expect(unknown.stderr).toContain("Usage:");

    const badOption = await runCli(["run", "--nope"], env);
    expect(badOption.stderr).toContain("Usage:");

    const missingConfig = await runCli(["run", "--url", "http://127.0.0.1:1/", "--config", "nope.ts"], env);
    expect(missingConfig.code).toBe(3);
    expect(missingConfig.stderr).toContain("--config file not found");
    expect(missingConfig.stderr).not.toContain("Usage:");
  });
});

describe("cancelling katalepsis run", () => {
  it("stops Playwright and its browsers, then writes a blocked report", async () => {
    const cancelOut = await mkdtemp(path.join(tmpdir(), "katalepsis-cancel-"));
    const baseline = browserProcesses();
    const child = spawn(process.execPath, [
      cli,
      "run",
      "--url",
      `http://127.0.0.1:${port}/`,
      "--cwd",
      demo,
      "--out",
      cancelOut,
    ]);
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    await new Promise((resolve) => setTimeout(resolve, 2500));
    child.kill("SIGINT");
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));

    expect(code).toBe(2);
    const manifest = JSON.parse(await readFile(path.join(bundleFrom(stdout), "manifest.json"), "utf8"));
    expect(manifest.status).toBe("blocked");
    expect(JSON.stringify(manifest.errors)).toContain("cancelled");
    // pgrep exits 1 when no process matches: the Playwright CLI and workers for this run are gone.
    expect(() => execFileSync("pgrep", ["-f", cancelOut])).toThrow(/Command failed: pgrep/);
    expect(await leftoverBrowsers(baseline)).toEqual([]);
    await rm(cancelOut, { recursive: true, force: true });
  });
});
