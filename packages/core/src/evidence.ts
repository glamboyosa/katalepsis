import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { ReportWriteError } from "./errors.ts";
import type { PendingAttachment } from "./playwright-report.ts";
import { isBundlePath, type EvidenceFile } from "./schema.ts";

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "attachment";

const extensionOf = (sourcePath: string): string => {
  const extension = path.extname(sourcePath).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : "";
};

/** Resolves a bundle-relative path and refuses anything that would land outside the bundle. */
export const resolveInBundle = (bundleDir: string, relativePath: string): string => {
  const resolved = path.resolve(bundleDir, ...relativePath.split("/"));
  if (!isBundlePath(relativePath) || !resolved.startsWith(path.resolve(bundleDir) + path.sep)) {
    throw new Error(`Refusing to write outside the report bundle: ${relativePath}`);
  }
  return resolved;
};

const sha256File = async (filePath: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");

export type CopiedEvidence = {
  readonly files: ReadonlyArray<EvidenceFile>;
  /** Attachments Playwright listed whose files no longer exist. */
  readonly missing: ReadonlyArray<PendingAttachment>;
};

/**
 * Copies Playwright attachments into `evidence/<checkId>/` inside the bundle and records
 * their size and SHA-256. Destination names are generated, never taken from test output.
 */
export const copyEvidence = (
  bundleDir: string,
  attachments: ReadonlyArray<PendingAttachment>,
  /** Used when Playwright did not report when the attempt ran. */
  fallbackCapturedAt: string,
): Effect.Effect<CopiedEvidence, ReportWriteError> =>
  Effect.tryPromise({
    try: async () => {
      const files: Array<EvidenceFile> = [];
      const missing: Array<PendingAttachment> = [];
      const used = new Set<string>();
      for (const attachment of attachments) {
        const exists = await stat(attachment.sourcePath).then(
          (info) => info.isFile(),
          () => false,
        );
        if (!exists) {
          missing.push(attachment);
          continue;
        }
        const stem = `evidence/${attachment.checkId}/retry-${attachment.retry}-${slug(attachment.name)}`;
        const extension = extensionOf(attachment.sourcePath);
        let relativePath = `${stem}${extension}`;
        for (let index = 2; used.has(relativePath); index += 1) relativePath = `${stem}-${index}${extension}`;
        used.add(relativePath);

        const destination = resolveInBundle(bundleDir, relativePath);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(attachment.sourcePath, destination);
        files.push({
          path: relativePath,
          mimeType: attachment.contentType,
          kind: attachment.kind,
          bytes: (await stat(destination)).size,
          sha256: await sha256File(destination),
          checkId: attachment.checkId,
          attempt: attachment.retry,
          capturedAt: attachment.capturedAt ?? fallbackCapturedAt,
        });
      }
      return { files, missing };
    },
    catch: (cause) => new ReportWriteError({ message: `Could not copy evidence: ${String(cause)}` }),
  });

/** Writes a run-level text file, such as the Playwright process log, as evidence. */
export const writeRunLog = (
  bundleDir: string,
  relativePath: string,
  contents: string,
  capturedAt: string,
): Effect.Effect<EvidenceFile, ReportWriteError> =>
  Effect.tryPromise({
    try: async () => {
      const destination = resolveInBundle(bundleDir, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, contents);
      return {
        path: relativePath,
        mimeType: "text/plain",
        kind: "log" as const,
        bytes: Buffer.byteLength(contents),
        sha256: createHash("sha256").update(contents).digest("hex"),
        checkId: null,
        attempt: null,
        capturedAt,
      };
    },
    catch: (cause) => new ReportWriteError({ message: `Could not write ${relativePath}: ${String(cause)}` }),
  });
