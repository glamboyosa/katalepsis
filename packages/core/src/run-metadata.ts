import { execFile } from "node:child_process";
import { Context, Effect, Layer } from "effect";

export class RunMetadata extends Context.Service<
  RunMetadata,
  {
    readonly now: Effect.Effect<Date>;
    /** Returns the HEAD commit of the checkout at `cwd`, or null when there is none. */
    readonly commitSha: (cwd: string) => Effect.Effect<string | null>;
    /** Returns the `origin` remote with any credentials removed, or null. */
    readonly repository: (cwd: string) => Effect.Effect<string | null>;
  }
>()("katalepsis/RunMetadata") {}

const git = (cwd: string, args: ReadonlyArray<string>): Effect.Effect<string | null> =>
  Effect.callback<string | null>((resume) => {
    const child = execFile("git", [...args], { cwd, timeout: 5_000 }, (error, stdout) => {
      resume(Effect.succeed(error ? null : stdout.trim()));
    });
    return Effect.sync(() => child.kill());
  });

const withoutCredentials = (remote: string): string => {
  try {
    const url = new URL(remote);
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    // scp-style remotes such as git@github.com:owner/repo.git carry no secret.
    return remote;
  }
};

export const RunMetadataLive = Layer.succeed(RunMetadata, {
  now: Effect.sync(() => new Date()),
  commitSha: (cwd) =>
    git(cwd, ["rev-parse", "--verify", "HEAD"]).pipe(
      Effect.map((sha) => (sha !== null && /^[0-9a-f]{40}$/.test(sha) ? sha : null)),
    ),
  repository: (cwd) =>
    git(cwd, ["remote", "get-url", "origin"]).pipe(
      Effect.map((remote) => (remote ? withoutCredentials(remote) : null)),
    ),
});
