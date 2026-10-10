import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { setupLocalModel, verifyWithAgent } from "@katalepsis/agent";
import {
  PlaywrightRunnerLive,
  PreviewProbeLive,
  RunMetadataLive,
  VerificationRun,
  verifyWithPlaywright,
} from "@katalepsis/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Layer, Schema } from "effect";
import { CheckBrowserInput, GetReportInput, RunTestsInput, TOOLS } from "./tools.ts";

export type ServerOptions = {
  /** Every cwd a tool receives must resolve inside this directory. */
  readonly root: string;
  readonly version: string;
  readonly env: Readonly<Record<string, string | undefined>>;
};

const REPORTS = path.join("artifacts", "katalepsis");
const MAX_TEXT = 60_000;
// Below the 600-second tool timeout the setup guide gives clients, so a run ends, and
// reports, before the client gives up on it.
const DEFAULT_RUN_TIMEOUT_SECONDS = 540;
const AGENT_BUDGET = { maxSteps: 15, maxTotalTokens: 200_000, timeoutMs: 120_000 };
// Agent runs stop after this long overall; checks not reached are reported as not run.
const AGENT_RUN_LIMIT_MS = DEFAULT_RUN_TIMEOUT_SECONDS * 1000;

/** A tool failure the caller can act on. Its message is shown to the agent as is. */
class ToolError extends Error {}

const ok = (summary: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
  structuredContent: summary,
});

const failure = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

const decode = <S extends Schema.Codec<unknown, unknown>>(schema: S, input: unknown): S["Type"] => {
  try {
    // Unknown keys are rejected, so a stray field such as an API key is never silently ignored.
    return Schema.decodeUnknownSync(schema)(input ?? {}, { onExcessProperty: "error" });
  } catch (error) {
    throw new ToolError(`Invalid arguments: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/** Resolves a project directory and refuses anything outside the workspace root, symlinks included. */
const projectDir = async (root: string, cwd: string | undefined): Promise<string> => {
  const resolved = await realpath(path.resolve(root, cwd ?? ".")).catch(() => {
    throw new ToolError(`No such directory inside the workspace: ${cwd ?? "."}`);
  });
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new ToolError("cwd must be inside the workspace root this server was started with.");
  }
  return resolved;
};

/**
 * The report folder inside a project. Neither `artifacts` nor `artifacts/katalepsis` may be a
 * symlink, so reports are never written or read outside the project.
 */
const reportsDir = async (cwd: string): Promise<string> => {
  const artifacts = path.join(cwd, "artifacts");
  for (const dir of [artifacts, path.join(cwd, REPORTS)]) {
    const info = await lstat(dir).catch(() => null);
    if (info !== null && !info.isDirectory()) {
      throw new ToolError(`${path.relative(cwd, dir)} must be a real directory, not a link or a file.`);
    }
  }
  return path.join(cwd, REPORTS);
};

/** Reads a report file only if it is a regular file, not a link to somewhere else. */
const readReportFile = async (file: string): Promise<string> => {
  const info = await lstat(file).catch(() => null);
  if (info === null || !info.isFile()) throw new ToolError(`${path.basename(file)} is missing from this report.`);
  return readFile(file, "utf8");
};

const summarize = (run: VerificationRun, bundleDir: string) => ({
  runId: run.id,
  status: run.status,
  previewUrl: run.previewUrl,
  commit: run.commitSha ?? "unknown",
  model: run.model,
  counts: {
    passed: run.checks.filter((check) => check.status === "passed").length,
    failed: run.checks.filter((check) => check.status === "failed").length,
    blocked: run.checks.filter((check) => check.status === "blocked").length,
    notTested: run.notTested.length,
  },
  checks: run.checks.map((check) => ({
    id: check.id,
    title: check.titlePath.join(" › "),
    status: check.status,
    ...(check.failure === null ? {} : { failure: check.failure }),
  })),
  notTested: run.notTested.map((item) => ({ title: item.title, reason: item.reason })),
  errors: run.errors.map((error) => ({ category: error.category, message: error.message })),
  report: {
    html: path.join(bundleDir, "report.html"),
    markdown: path.join(bundleDir, "report.md"),
    manifest: path.join(bundleDir, "manifest.json"),
  },
});

/** Turns katalepsis's typed failures into a message for the agent. */
const runEffect = <A>(effect: Effect.Effect<A, { readonly _tag: string; readonly message: string }>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.mapError((error) => new ToolError(error.message)))).catch((error: unknown) => {
    throw error instanceof ToolError ? error : new ToolError(error instanceof Error ? error.message : String(error));
  });

const truncate = (text: string): string =>
  text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… truncated; read the file for the rest.` : text;

/**
 * The katalepsis MCP server. It exposes three high-level tools, not raw browser control,
 * runs one verification at a time, keeps every path inside the workspace root, and never
 * accepts credentials as arguments: agent checks use the local environment or keychain.
 *
 * It uses the SDK's lower-level Server so tool inputs are validated with Effect Schema,
 * like the rest of katalepsis, instead of the zod schemas McpServer requires.
 */
export type KatalepsisServer = {
  readonly server: Server;
  /** Resolves once no run is in progress, so the process can exit after a run has cleaned up. */
  readonly idle: () => Promise<void>;
};

export const createServer = (options: ServerOptions): KatalepsisServer => {
  const server = new Server({ name: "katalepsis", version: options.version }, { capabilities: { tools: {} } });
  let current: { readonly startedAt: Date; readonly done: Promise<unknown> } | null = null;

  const exclusive = (work: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    if (current !== null) {
      const seconds = Math.round((Date.now() - current.startedAt.getTime()) / 1000);
      return Promise.resolve(
        failure(`Another katalepsis run started ${seconds}s ago and is still going. Try again when it finishes.`),
      );
    }
    const done = work().finally(() => {
      current = null;
    });
    current = { startedAt: new Date(), done };
    return done;
  };

  // Arguments are checked before taking the lock, so a bad call is answered at once.
  const runTests = (args: unknown, signal: AbortSignal) => {
    const input = decode(RunTestsInput, args);
    return exclusive(async () => {
      const cwd = await projectDir(options.root, input.cwd);
      const { run, bundleDir } = await runEffect(
        verifyWithPlaywright({
          previewUrl: input.baseUrl,
          cwd,
          outDir: await reportsDir(cwd),
          config: null,
          projects: input.project ?? [],
          grep: input.grep ?? null,
          timeoutMs: (input.timeoutSeconds ?? DEFAULT_RUN_TIMEOUT_SECONDS) * 1000,
          environment: "mcp",
          toolVersion: options.version,
          signal,
        }).pipe(Effect.provide(Layer.mergeAll(PlaywrightRunnerLive, PreviewProbeLive, RunMetadataLive))),
      );
      return ok(summarize(run, bundleDir));
    });
  };

  const checkBrowser = (args: unknown, signal: AbortSignal) => {
    const input = decode(CheckBrowserInput, args);
    return exclusive(async () => {
      const cwd = await projectDir(options.root, input.cwd);
      const { run, bundleDir } = await runEffect(
        verifyWithAgent({
          previewUrl: input.baseUrl,
          checks: { checks: input.checks },
          checksFile: "mcp request",
          cwd,
          outDir: await reportsDir(cwd),
          extraOrigins: input.allowOrigins ?? [],
          budget: AGENT_BUDGET,
          environment: "mcp",
          toolVersion: options.version,
          signal: AbortSignal.any([signal, AbortSignal.timeout(AGENT_RUN_LIMIT_MS)]),
          setupModel: () =>
            setupLocalModel(options.env, { provider: input.provider ?? null, model: input.model ?? null }),
        }).pipe(Effect.provide(Layer.merge(PreviewProbeLive, RunMetadataLive))),
      );
      return ok(summarize(run, bundleDir));
    });
  };

  const getReport = async (args: unknown): Promise<CallToolResult> => {
    const input = decode(GetReportInput, args);
    const cwd = await projectDir(options.root, input.cwd);
    const reports = await reportsDir(cwd);
    const bundleDir = path.join(reports, input.runId);
    const bundle = await lstat(bundleDir).catch(() => null);
    if (bundle === null || !bundle.isDirectory()) {
      throw new ToolError(`No report ${input.runId} in ${path.relative(options.root, cwd) || "."}.`);
    }
    const manifestText = await readReportFile(path.join(bundleDir, "manifest.json"));
    let run: VerificationRun;
    try {
      run = Schema.decodeUnknownSync(VerificationRun)(JSON.parse(manifestText));
    } catch {
      throw new ToolError(`Report ${input.runId} is unreadable or from an incompatible katalepsis version.`);
    }
    const format = input.format ?? "summary";
    if (format === "summary") return ok(summarize(run, bundleDir));
    const text = format === "markdown" ? await readReportFile(path.join(bundleDir, "report.md")) : manifestText;
    return { content: [{ type: "text", text: truncate(text) }] };
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...TOOLS] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      switch (request.params.name) {
        case "verification_run_tests":
          return await runTests(request.params.arguments, extra.signal);
        case "verification_check_browser":
          return await checkBrowser(request.params.arguments, extra.signal);
        case "verification_get_report":
          return await getReport(request.params.arguments);
        default:
          return failure(`Unknown tool: ${request.params.name}`);
      }
    } catch (error) {
      if (error instanceof ToolError) return failure(error.message);
      // Unexpected errors are reported without stack traces or internals.
      return failure("katalepsis hit an internal error. Run the same check with the katalepsis CLI for details.");
    }
  });
  return {
    server,
    idle: async () => {
      await current?.done.catch(() => undefined);
    },
  };
};
