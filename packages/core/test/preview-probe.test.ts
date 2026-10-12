import { createServer, type Server, type ServerResponse } from "node:http";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PreviewProbe, PreviewProbeLive } from "../src/index.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

const html = (response: ServerResponse, body: string) =>
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);

const ROUTES: Record<string, (response: ServerResponse) => void> = {
  "/header": (response) => response.writeHead(200, { "x-commit-sha": SHA.toUpperCase() }).end("ok"),
  "/meta": (response) =>
    html(response, `<!doctype html><head><meta content='${SHA}' name="Commit-SHA"><title>App</title></head>`),
  "/both": (response) =>
    response
      .writeHead(200, { "content-type": "text/html", "x-commit-sha": "abcdef1" })
      .end(`<meta name="commit-sha" content="${SHA}">`),
  "/not-a-sha": (response) => html(response, '<meta name="commit-sha" content="main">'),
  "/other-meta": (response) => html(response, `<meta name="description" content="${SHA}">`),
  "/json": (response) =>
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(`{"meta":"<meta name=\\"commit-sha\\" content=\\"${SHA}\\">"}`),
  "/late": (response) => html(response, `${" ".repeat(600 * 1024)}<meta name="commit-sha" content="${SHA}">`),
  "/commented": (response) =>
    html(response, `<!-- <meta name="commit-sha" content="abcdef1"> --><meta name="commit-sha" content="${SHA}">`),
  "/streaming": (response) => {
    // The head arrives at once, but the body stays open, as with a streamed server-rendered page.
    response.writeHead(200, { "content-type": "text/html" });
    response.write(`<head><meta name="commit-sha" content="${SHA}"></head><body>`);
  },
  "/down": (response) => response.writeHead(503, { "x-commit-sha": SHA }).end(),
};

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((request, response) =>
    (ROUTES[request.url ?? ""] ?? ((res) => res.writeHead(404).end()))(response),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const probe = (route: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* PreviewProbe;
      return yield* service.check(`${origin}${route}`, new AbortController().signal);
    }).pipe(Effect.provide(PreviewProbeLive)),
  );

describe("PreviewProbeLive commit detection", () => {
  it("reads the x-commit-sha header", async () => {
    expect(await probe("/header")).toEqual({ reachable: true, commit: { sha: SHA, source: "header" } });
  });

  it("reads the commit-sha meta tag in any attribute order and case", async () => {
    expect(await probe("/meta")).toEqual({ reachable: true, commit: { sha: SHA, source: "meta" } });
  });

  it("ignores a commented-out meta tag", async () => {
    expect(await probe("/commented")).toEqual({ reachable: true, commit: { sha: SHA, source: "meta" } });
  });

  it("stops reading at the end of the head instead of waiting for the whole page", async () => {
    expect(await probe("/streaming")).toEqual({ reachable: true, commit: { sha: SHA, source: "meta" } });
  });

  it("prefers the header over the meta tag", async () => {
    expect(await probe("/both")).toEqual({ reachable: true, commit: { sha: "abcdef1", source: "header" } });
  });

  it.each(["/not-a-sha", "/other-meta", "/json", "/late", "/missing"])(
    "reports no commit for %s and still treats the preview as reachable",
    async (route) => {
      expect(await probe(route)).toEqual({ reachable: true, commit: null });
    },
  );

  it("does not read a commit from a preview that is down", async () => {
    expect(await probe("/down")).toEqual({ reachable: false, reason: "the preview answered with HTTP 503" });
  });
});
