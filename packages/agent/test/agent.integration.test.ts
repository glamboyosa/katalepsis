import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, type Server } from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PreviewProbeLive, RunMetadata } from "@katalepsis/core";
import { Effect, Layer } from "effect";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyWithAgent, type AgentCheck, type AgentVerifyOptions, type ModelSetup } from "../src/index.ts";
import { scriptedModel, type ScriptedCall, type ScriptedStep } from "./scripted-model.ts";

const demo = fileURLToPath(new URL("../../../apps/demo-form/", import.meta.url));
const FAKE_KEY = "sk-test-fake-key-0123456789";

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
let baseUrl: string;
let outDir: string;
// A page with an open redirect and a popup link to another origin, and that other origin.
let linksServer: Server;
let elsewhereServer: Server;
let linksUrl: string;
let elsewhereHits = 0;

const listen = (handler: Parameters<typeof createHttpServer>[1]): Promise<{ server: Server; url: string }> =>
  new Promise((resolve) => {
    const created = createHttpServer(handler);
    created.listen(0, "127.0.0.1", () => {
      const address = created.address();
      resolve({
        server: created,
        url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`,
      });
    });
  });

beforeAll(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}/`;
  outDir = await mkdtemp(path.join(tmpdir(), "katalepsis-agent-"));
  server = spawn(process.execPath, [path.join(demo, "server.mjs")], {
    env: { ...process.env, PORT: String(port) },
    stdio: "pipe",
  });
  await new Promise<void>((resolve) => server.stdout?.once("data", () => resolve()));

  const elsewhere = await listen((_request, response) => {
    elsewhereHits += 1;
    response.writeHead(200, { "content-type": "text/html" }).end("<h1>Elsewhere</h1>");
  });
  elsewhereServer = elsewhere.server;
  const links = await listen((request, response) => {
    if (request.url === "/about") {
      response.writeHead(200, { "content-type": "text/html" }).end('<h1>About</h1><a href="/">Home</a>');
      return;
    }
    if (request.url === "/plans") {
      response
        .writeHead(200, { "content-type": "text/html" })
        .end(
          "<button onclick=\"document.getElementById('plans').hidden = false\">Show plans</button>" +
            '<ul id="plans" hidden><li>Plan A <span>$5</span></li><li>Plan\n   B&nbsp;yearly</li></ul>',
        );
      return;
    }
    if (request.url === "/go") {
      response.writeHead(302, { location: elsewhere.url }).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "text/html" })
      .end(`<h1>Links</h1><a href="/go">Go</a> <a href="${elsewhere.url}" target="_blank">Open</a>`);
  });
  linksServer = links.server;
  linksUrl = links.url;
});

afterAll(async () => {
  server.kill();
  linksServer.close();
  elsewhereServer.close();
  await rm(outDir, { recursive: true, force: true });
});

/** PIDs of Playwright-managed browsers, which run from the ms-playwright cache. */
const browserProcesses = (): Set<string> => {
  try {
    return new Set(execFileSync("pgrep", ["-f", "ms-playwright"], { encoding: "utf8" }).trim().split("\n"));
  } catch {
    // pgrep exits 1 when nothing matches.
    return new Set();
  }
};

const leftoverBrowsers = async (baseline: ReadonlySet<string>): Promise<Array<string>> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ([...browserProcesses()].every((pid) => baseline.has(pid))) return [];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return [...browserProcesses()].filter((pid) => !baseline.has(pid));
};

const Metadata = Layer.succeed(RunMetadata, {
  now: Effect.sync(() => new Date()),
  commitSha: () => Effect.succeed(null),
  repository: () => Effect.succeed(null),
});

const check = (id: string, overrides: Partial<AgentCheck> = {}): AgentCheck => ({
  id,
  name: id,
  intent: "Exercise the signup form",
  passCondition: "The expected message is visible",
  ...overrides,
});

/** Runs a single check with a scripted model standing in for the provider. */
const runOne = async (script: ReadonlyArray<ScriptedStep>, overrides: Partial<AgentVerifyOptions> = {}) => {
  const setupModel = async (): Promise<ModelSetup> => ({
    model: scriptedModel(script),
    info: { provider: "test", id: "scripted" },
    secrets: [FAKE_KEY],
  });
  const options: AgentVerifyOptions = {
    previewUrl: baseUrl,
    checks: { checks: [check("signup")] },
    checksFile: "checks.json",
    cwd: demo,
    outDir,
    extraOrigins: [],
    budget: { maxSteps: 8, maxTotalTokens: 100_000, timeoutMs: 60_000 },
    environment: "test",
    toolVersion: "0.0.0-test",
    signal: new AbortController().signal,
    setupModel,
    ...overrides,
  };
  const outcome = await Effect.runPromise(
    verifyWithAgent(options).pipe(Effect.provide(Layer.merge(PreviewProbeLive, Metadata))),
  );
  const [result] = outcome.run.checks;
  if (result === undefined) throw new Error("no check in the run");
  return { ...outcome, result };
};

const submitEmpty: ReadonlyArray<ScriptedCall> = [
  { tool: "snapshot", input: {} },
  { tool: "click", input: { role: "button", name: "Sign up" } },
  { tool: "assert", input: { expectation: "visible", text: "required" } },
];

describe("verifyWithAgent on the demo signup form", () => {
  it("fails a check when the cited browser assertion fails", async () => {
    const { result, run } = await runOne([
      ...submitEmpty,
      { tool: "finish", input: { verdict: "failed", summary: "No error appeared.", assertionIds: ["a1"] } },
    ]);
    expect(result.status).toBe("failed");
    expect(result.source).toBe("agent");
    expect(result.observed).toContain('a1 FAILED: text "required" is visible');
    expect(run.status).toBe("failed");
    expect(run.model).toEqual({ provider: "test", id: "scripted" });
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/a1-screenshot\.png$/),
        expect.stringMatching(/trace\.zip$/),
        expect.stringMatching(/actions\.json$/),
      ]),
    );
  });

  it("passes a check only with a passing cited assertion", async () => {
    const { result } = await runOne([
      { tool: "fill", input: { label: "Name", value: "Test Person" } },
      { tool: "fill", input: { label: "Email", value: "test.person@example.com" } },
      { tool: "click", input: { role: "button", name: "Sign up" } },
      { tool: "assert", input: { expectation: "visible", text: "Thanks, you're signed up." } },
      { tool: "finish", input: { verdict: "passed", summary: "Confirmation shown.", assertionIds: ["a1"] } },
    ]);
    expect(result.status).toBe("passed");
    expect(result.failure).toBeNull();
  });

  it("runs tool calls from one step in order, so parallel fills and assertions stay separate", async () => {
    const { result } = await runOne([
      [
        { tool: "fill", input: { label: "Name", value: "Test Person" } },
        { tool: "fill", input: { label: "Email", value: "test.person@example.com" } },
      ],
      { tool: "click", input: { role: "button", name: "Sign up" } },
      [
        { tool: "assert", input: { expectation: "visible", text: "Thanks, you're signed up." } },
        { tool: "assert", input: { expectation: "hidden", role: "alert" } },
      ],
      { tool: "finish", input: { verdict: "passed", summary: "Confirmed.", assertionIds: ["a1", "a2"] } },
    ]);
    expect(result.status).toBe("passed");
    expect(result.observed).toContain("- a1 PASSED");
    expect(result.observed).toContain("- a2 PASSED");
  });

  it("blocks a pass the model claims without evidence", async () => {
    const { result } = await runOne([
      { tool: "snapshot", input: {} },
      { tool: "finish", input: { verdict: "passed", summary: "Looks right to me.", assertionIds: [] } },
    ]);
    expect(result.status).toBe("blocked");
    expect(result.failure?.code).toBe("no-evidence");
  });

  it("blocks a pass whose cited assertion actually failed", async () => {
    const { result } = await runOne([
      ...submitEmpty,
      { tool: "finish", input: { verdict: "passed", summary: "Error shown.", assertionIds: ["a1"] } },
    ]);
    expect(result.status).toBe("blocked");
  });

  it("blocks when the model runs out of steps without a verdict", async () => {
    const { result } = await runOne([{ tool: "snapshot", input: {} }], {
      budget: { maxSteps: 3, maxTotalTokens: 100_000, timeoutMs: 60_000 },
    });
    expect(result.status).toBe("blocked");
    expect(result.failure).toMatchObject({ code: "budget", message: "The agent used its 3 steps without a verdict." });
  });

  it("blocks when the model runs out of tokens", async () => {
    const { result } = await runOne([{ tool: "snapshot", input: {} }], {
      budget: { maxSteps: 20, maxTotalTokens: 250, timeoutMs: 60_000 },
    });
    expect(result.status).toBe("blocked");
    expect(result.failure?.message).toContain("token budget");
  });

  it("refuses to navigate outside the allowlist", async () => {
    const { result, bundleDir } = await runOne([
      { tool: "navigate", input: { target: "https://example.com/" } },
      { tool: "finish", input: { verdict: "blocked", summary: "Could not leave the site.", assertionIds: [] } },
    ]);
    const actionsPath = result.evidence.find((file) => file.endsWith("actions.json"));
    if (actionsPath === undefined) throw new Error("no action log");
    const log = JSON.parse(await readFile(path.join(bundleDir, actionsPath), "utf8"));
    expect(log.actions.find((action: { tool: string }) => action.tool === "navigate")).toMatchObject({
      ok: false,
      result: "Refused: https://example.com is not in the allowlist.",
    });
    expect(elsewhereHits).toBe(0);
  });

  it("blocks a pass supported only by an assertion that something absent is hidden", async () => {
    const { result } = await runOne([
      { tool: "click", input: { role: "button", name: "Sign up" } },
      { tool: "assert", input: { expectation: "hidden", text: "zzz nothing like this" } },
      { tool: "finish", input: { verdict: "passed", summary: "Nothing bad shown.", assertionIds: ["a1"] } },
    ]);
    expect(result.status).toBe("blocked");
    expect(result.observed).toContain("needs something visible");
  });

  it("matches a role by the text a model gives instead of a name", async () => {
    const { result } = await runOne([
      { tool: "click", input: { role: "button", text: "Sign up" } },
      { tool: "assert", input: { expectation: "visible", role: "heading", text: "Welcome back" } },
      { tool: "finish", input: { verdict: "passed", summary: "A heading is shown.", assertionIds: ["a1"] } },
    ]);
    expect(result.status).toBe("blocked");
    expect(result.observed).toContain('a1 FAILED: role "heading" with text "Welcome back" is visible');
  });

  it("matches an element by text shown inside it, beside other content", async () => {
    const { result } = await runOne(
      [
        { tool: "navigate", input: { target: "/plans" } },
        { tool: "click", input: { role: "button", text: "Show plans" } },
        { tool: "assert", input: { expectation: "visible", role: "listitem", text: "Plan A" } },
        { tool: "assert", input: { expectation: "visible", role: "listitem", text: "Plan B yearly" } },
        { tool: "finish", input: { verdict: "passed", summary: "Plans shown.", assertionIds: ["a1", "a2"] } },
      ],
      { previewUrl: linksUrl },
    );
    expect(result.observed).toContain('a1 PASSED: role "listitem" with text "Plan A" is visible');
    expect(result.observed).toContain('a2 PASSED: role "listitem" with text "Plan B yearly" is visible');
    expect(result.status).toBe("passed");
  });

  it("matches a status message by its text, although status roles take no name from their content", async () => {
    const signUp = [
      { tool: "fill", input: { label: "Name", value: "Test Person" } },
      { tool: "fill", input: { label: "Email", value: "test.person@example.com" } },
      { tool: "click", input: { role: "button", text: "Sign up" } },
    ];
    const shown = await runOne([
      ...signUp,
      { tool: "assert", input: { expectation: "visible", role: "status", text: "Thanks, you're signed up." } },
      { tool: "finish", input: { verdict: "passed", summary: "Confirmation shown.", assertionIds: ["a1"] } },
    ]);
    expect(shown.result.status).toBe("passed");

    const hidden = await runOne([
      ...signUp,
      { tool: "assert", input: { expectation: "hidden", role: "status", text: "Thanks, you're signed up." } },
      { tool: "finish", input: { verdict: "failed", summary: "Claims it is hidden.", assertionIds: ["a1"] } },
    ]);
    expect(hidden.result.observed).toContain(
      'a1 FAILED: role "status" with text "Thanks, you\'re signed up." is hidden',
    );
  });

  it("blocks a pass that cites a heading that was there before the agent acted", async () => {
    const { result } = await runOne([
      ...submitEmpty,
      { tool: "assert", input: { expectation: "visible", role: "heading", name: "Create an account" } },
      { tool: "finish", input: { verdict: "passed", summary: "The page is fine.", assertionIds: ["a2"] } },
    ]);
    expect(result.status).toBe("blocked");
    expect(result.observed).toContain("already on the page before it acted");
    expect(result.observed).toContain("Other assertions it ran:\n- a1 FAILED");
  });

  it("blocks a pass when the agent did nothing and cited what was already there", async () => {
    const { result } = await runOne([
      { tool: "assert", input: { expectation: "visible", role: "heading", name: "Create an account" } },
      { tool: "finish", input: { verdict: "passed", summary: "Looks right.", assertionIds: ["a1"] } },
    ]);
    expect(result.status).toBe("blocked");
  });

  it("blocks a pass about a page the agent simply opened by URL", async () => {
    const { result } = await runOne(
      [
        { tool: "navigate", input: { target: "/about" } },
        { tool: "assert", input: { expectation: "visible", role: "heading", name: "About" } },
        { tool: "finish", input: { verdict: "passed", summary: "Found it.", assertionIds: ["a1"] } },
      ],
      { previewUrl: linksUrl },
    );
    expect(result.status).toBe("blocked");
    expect(result.observed).toContain("also visible on an untouched copy of the page");
  });

  it("blocks a pass about the start page after the agent wanders off and clicks back", async () => {
    const { result } = await runOne(
      [
        { tool: "navigate", input: { target: "/about" } },
        { tool: "click", input: { role: "link", name: "Home" } },
        { tool: "assert", input: { expectation: "visible", role: "heading", name: "Links" } },
        { tool: "finish", input: { verdict: "passed", summary: "Back home.", assertionIds: ["a1"] } },
      ],
      { previewUrl: linksUrl },
    );
    expect(result.status).toBe("blocked");
  });

  it("blocks a check when a same-origin link redirects to another origin", async () => {
    const { result } = await runOne(
      [
        { tool: "click", input: { role: "link", name: "Go" } },
        { tool: "assert", input: { expectation: "visible", role: "heading", name: "Elsewhere" } },
        { tool: "finish", input: { verdict: "passed", summary: "Arrived.", assertionIds: ["a1"] } },
      ],
      { previewUrl: linksUrl },
    );
    expect(result.status).toBe("blocked");
    expect(result.failure?.code).toBe("navigation");
  });

  it("blocks a check when the page opens another origin in a new tab", async () => {
    const hitsBefore = elsewhereHits;
    const { result } = await runOne(
      [
        { tool: "click", input: { role: "link", name: "Open" } },
        { tool: "finish", input: { verdict: "blocked", summary: "Opened a tab.", assertionIds: [] } },
      ],
      { previewUrl: linksUrl },
    );
    expect(result.failure?.code).toBe("navigation");
    expect(elsewhereHits).toBe(hitsBefore);
  });

  it("stops a check mid-run when cancelled, writes the report and closes the browser", async () => {
    const baseline = browserProcesses();
    const controller = new AbortController();
    let step = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        step += 1;
        if (step === 2) controller.abort();
        return {
          content: [{ type: "tool-call", toolCallId: `c${step}`, toolName: "snapshot", input: "{}" }],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 0, text: 0, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
    const { result, run, bundleDir } = await runOne([], {
      signal: controller.signal,
      setupModel: async () => ({ model, info: { provider: "test", id: "scripted" }, secrets: [] }),
    });
    expect(result.failure?.code).toBe("interrupted");
    expect(run.errors.map((error) => error.stage)).toEqual(["cancel"]);
    expect(await readdir(bundleDir)).toContain("report.html");
    expect(await leftoverBrowsers(baseline)).toEqual([]);
  });

  it("blocks a check whose model call outlives the check timeout", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: ({ abortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal?.addEventListener("abort", () => reject(abortSignal.reason));
        }),
    });
    const { result } = await runOne([], {
      budget: { maxSteps: 5, maxTotalTokens: 1000, timeoutMs: 500 },
      setupModel: async () => ({ model, info: { provider: "test", id: "slow" }, secrets: [] }),
    });
    expect(result.failure).toMatchObject({ code: "budget", message: "The check ran out of time." });
  });

  it("blocks every check without calling the model when the preview is down", async () => {
    let modelSetups = 0;
    const { result, run } = await runOne([], {
      previewUrl: "http://127.0.0.1:9/",
      setupModel: async () => {
        modelSetups += 1;
        return { error: { category: "configuration", message: "unused", stage: "model", retryable: false } };
      },
    });
    expect(modelSetups).toBe(0);
    expect(result.failure?.code).toBe("preview-unavailable");
    expect(run.errors.map((error) => error.category)).toEqual(["preview-unavailable"]);
  });

  it("blocks every check with the setup error when the model cannot be used", async () => {
    const { result, run } = await runOne([], {
      setupModel: async () => ({
        error: {
          category: "credentials",
          message: "No OpenAI key. Run `katalepsis auth set openai`.",
          stage: "model-setup",
          retryable: false,
        },
      }),
    });
    expect(result.status).toBe("blocked");
    expect(run.errors.map((error) => error.category)).toEqual(["credentials"]);
  });

  it("blocks every check as interrupted when the run is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { result, run } = await runOne([], { signal: controller.signal });
    expect(result.failure?.code).toBe("interrupted");
    expect(run.errors.map((error) => error.stage)).toEqual(["cancel"]);
  });

  it("never writes the API key into the bundle", async () => {
    const { bundleDir, result } = await runOne([
      { tool: "fill", input: { label: "Name", value: FAKE_KEY } },
      { tool: "fill", input: { label: "Email", value: "test.person@example.com" } },
      { tool: "click", input: { role: "button", name: "Sign up" } },
      { tool: "assert", input: { expectation: "visible", text: "Thanks, you're signed up." } },
      { tool: "finish", input: { verdict: "passed", summary: `Typed ${FAKE_KEY}`, assertionIds: ["a1"] } },
    ]);
    expect(result.status).toBe("passed");
    const entries = await readdir(bundleDir, { recursive: true, withFileTypes: true });
    for (const entry of entries.filter((item) => item.isFile() && /\.(json|md|html|log)$/.test(item.name))) {
      expect(await readFile(path.join(entry.parentPath, entry.name), "utf8")).not.toContain(FAKE_KEY);
    }
  });
});
