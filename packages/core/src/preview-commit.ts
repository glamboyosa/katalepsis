import { Effect } from "effect";
import { ConfigurationError } from "./errors.ts";
import type { CommitAlignment, PreviewCommit, RunError, VerificationRun } from "./schema.ts";

/** The response header the preview probe reads the deployed commit from. */
export const COMMIT_HEADER = "x-commit-sha";
/** The `<meta name>` the preview probe reads the deployed commit from when the header is absent. */
export const COMMIT_META_NAME = "commit-sha";

const SHA = /^[0-9a-f]{7,40}$/;

/** Returns the value as a lowercase commit SHA of 7 to 40 hex characters, or null when it is not one. */
export const parseCommitSha = (value: string): string | null => {
  const sha = value.trim().toLowerCase();
  return SHA.test(sha) ? sha : null;
};

/** Validates a commit the caller says the preview was built from. It is used only when the preview reports none. */
export const previewCommitOption = (
  value: string | null | undefined,
): Effect.Effect<PreviewCommit | null, ConfigurationError> => {
  if (value === null || value === undefined) return Effect.succeed(null);
  const sha = parseCommitSha(value);
  return sha === null
    ? Effect.fail(
        new ConfigurationError({ message: "The preview commit must be a git commit SHA of 7 to 40 hex characters." }),
      )
    : Effect.succeed({ sha, source: "option" });
};

const ATTRIBUTE = /([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

/** Reads `<meta name="commit-sha" content="…">` from an HTML document. */
export const commitFromHtml = (html: string): string | null => {
  const withoutComments = html.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  for (const [tag] of withoutComments.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = new Map(
      [...tag.matchAll(ATTRIBUTE)].map((match) => [
        (match[1] ?? "").toLowerCase(),
        match[2] ?? match[3] ?? match[4] ?? "",
      ]),
    );
    if (attributes.get("name")?.toLowerCase() === COMMIT_META_NAME) {
      return parseCommitSha(attributes.get("content") ?? "");
    }
  }
  return null;
};

const SOURCE_LABEL: Record<PreviewCommit["source"], string> = {
  option: "passed to katalepsis",
  header: `from its ${COMMIT_HEADER} header`,
  meta: `from its ${COMMIT_META_NAME} meta tag`,
};

/** A short SHA from the preview matches the full checkout SHA it starts. */
const sameCommit = (checkout: string, preview: string): boolean => checkout.startsWith(preview);

/** Notes a commit the caller passed that lost to a different commit the preview reported. */
export const overriddenCommitNote = (given: PreviewCommit | null, reported: PreviewCommit | null): Array<string> =>
  given === null || reported === null || given.sha.startsWith(reported.sha) || reported.sha.startsWith(given.sha)
    ? []
    : [
        `The preview reported ${reported.sha} (${SOURCE_LABEL[reported.source]}), so the commit passed to katalepsis, ${given.sha}, was not used.`,
      ];

export type CommitComparison = {
  readonly alignment: CommitAlignment;
  /** The coverage limitation that explains the commit line of the report. */
  readonly limitation: string;
  /** A run error when the preview was built from another commit, so the run cannot pass. */
  readonly error: RunError | null;
};

/**
 * Compares the checkout HEAD with the commit the preview reported. A mismatch is a run
 * error: the checks ran against other code, so a pass says nothing about this checkout.
 */
export const compareCommits = (checkout: string | null, preview: PreviewCommit | null): CommitComparison => {
  if (checkout === null) {
    return {
      alignment: "unknown",
      limitation: "Commit is unknown: the project directory is not a git checkout with a commit.",
      error: null,
    };
  }
  if (preview === null) {
    return {
      alignment: "unknown",
      limitation: `Commit is the HEAD of the local checkout. The preview did not report its commit, so katalepsis cannot confirm the preview was built from it. Serve an ${COMMIT_HEADER} header or a ${COMMIT_META_NAME} meta tag, or pass the deployed commit (--preview-commit).`,
      error: null,
    };
  }
  if (sameCommit(checkout, preview.sha)) {
    return {
      alignment: "confirmed",
      limitation: `The preview commit ${preview.sha} (${SOURCE_LABEL[preview.source]}) matches the HEAD of the local checkout. Uncommitted changes in the checkout are not part of the preview.`,
      error: null,
    };
  }
  return {
    alignment: "mismatched",
    limitation: `The checks ran against commit ${preview.sha}, not the checkout HEAD ${checkout}. A pass is not evidence about the checkout.`,
    error: {
      category: "commit-mismatch",
      message: `The preview was built from ${preview.sha} (${SOURCE_LABEL[preview.source]}), but the checkout HEAD is ${checkout}. Wait for the preview of this commit and run again.`,
      stage: "preview-commit",
      retryable: true,
    },
  };
};

/** Says whether the preview was built from the checkout, for the commit line of a report or summary. */
export const alignmentSummary = (run: Pick<VerificationRun, "commitAlignment" | "previewCommit">): string => {
  if (run.commitAlignment === "confirmed") return "matches the checkout";
  if (run.commitAlignment === "mismatched") return "does not match the checkout";
  return run.previewCommit === null ? "not reported, so unconfirmed" : "unconfirmed, the checkout commit is unknown";
};
