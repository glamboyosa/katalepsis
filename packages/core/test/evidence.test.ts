import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyEvidence, isBundlePath, resolveInBundle, type PendingAttachment } from "../src/index.ts";

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "katalepsis-evidence-"));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const pending = (sourcePath: string, overrides: Partial<PendingAttachment> = {}): PendingAttachment => ({
  checkId: "abc123def456",
  retry: 0,
  name: "screenshot",
  contentType: "image/png",
  kind: "screenshot",
  sourcePath,
  capturedAt: null,
  ...overrides,
});

describe("copyEvidence", () => {
  it("copies attachments into the bundle with size and SHA-256", async () => {
    const source = path.join(workDir, "source dir with spaces", "test-failed-1.png");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "png bytes");
    const bundle = path.join(workDir, "bundle");

    const copied = await Effect.runPromise(copyEvidence(bundle, [pending(source)], "2026-01-01T00:00:00.000Z"));

    expect(copied.missing).toEqual([]);
    expect(copied.files).toEqual([
      {
        path: "evidence/abc123def456/retry-0-screenshot.png",
        mimeType: "image/png",
        kind: "screenshot",
        bytes: 9,
        sha256: createHash("sha256").update("png bytes").digest("hex"),
        checkId: "abc123def456",
        attempt: 0,
        capturedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(await readFile(path.join(bundle, "evidence/abc123def456/retry-0-screenshot.png"), "utf8")).toBe("png bytes");
  });

  it("stamps evidence with the attempt's end time when Playwright reported it", async () => {
    const source = path.join(workDir, "trace.zip");
    await writeFile(source, "zip");
    const copied = await Effect.runPromise(
      copyEvidence(
        path.join(workDir, "bundle"),
        [pending(source, { kind: "trace", capturedAt: "2026-01-01T00:00:02.500Z" })],
        "fallback",
      ),
    );
    expect(copied.files[0]?.capturedAt).toBe("2026-01-01T00:00:02.500Z");
  });

  it("reports a listed attachment whose file is gone instead of failing", async () => {
    const copied = await Effect.runPromise(
      copyEvidence(path.join(workDir, "bundle"), [pending(path.join(workDir, "video.webm"), { kind: "video" })], "t"),
    );
    expect(copied.files).toEqual([]);
    expect(copied.missing.map((item) => item.kind)).toEqual(["video"]);
  });

  it("generates its own file names, so a hostile attachment name cannot escape the bundle", async () => {
    const source = path.join(workDir, "a.txt");
    await writeFile(source, "x");
    const copied = await Effect.runPromise(
      copyEvidence(path.join(workDir, "bundle"), [pending(source, { name: "../../../etc/passwd", kind: "log" })], "t"),
    );
    expect(copied.files[0]?.path).toBe("evidence/abc123def456/retry-0-etc-passwd.txt");
  });

  it("does not overwrite two attachments with the same name", async () => {
    const source = path.join(workDir, "a.png");
    await writeFile(source, "x");
    const copied = await Effect.runPromise(
      copyEvidence(path.join(workDir, "bundle"), [pending(source), pending(source)], "t"),
    );
    expect(copied.files.map((file) => file.path)).toEqual([
      "evidence/abc123def456/retry-0-screenshot.png",
      "evidence/abc123def456/retry-0-screenshot-2.png",
    ]);
  });
});

describe("bundle paths", () => {
  it.each(["../x", "/etc/passwd", "a/../../x", "a\\b", "C:/x", "", "a//b", "./a"])("rejects %j", (candidate) => {
    expect(isBundlePath(candidate)).toBe(false);
  });

  it("accepts nested relative paths", () => {
    expect(isBundlePath("evidence/abc/retry-0-trace.zip")).toBe(true);
  });

  it("refuses to resolve a path outside the bundle", () => {
    expect(() => resolveInBundle("/tmp/bundle", "../outside")).toThrow(/outside the report bundle/);
  });
});
