import { execFileSync } from "child_process";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import type { GitHubClient } from "../engine/github/github.js";
import type { StateDb } from "../state/db.js";
import { logger } from "../logging/logger.js";

const log = logger("stale-base");

/** The phase whose cached result (and everything after it) is thrown away. */
const REBUILD_FROM = "executor";

function git(repoDir: string, args: string[]): string {
  return execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Has the default branch moved onto files this run's checkout also changed
 * since the run was cut from it? That is the stale-base shape: a retry replaying
 * cached phases onto an out-of-date branch.
 *
 * The run's base SHA is the merge-base of its checkout and `origin/<default>` —
 * what the clone recorded, nothing is fetched into the checkout. What main
 * touched since comes from GitHub's compare API, so the harness needs no git
 * credentials here. `null` from that API (over 300 files) counts as overlap.
 */
export async function baseIsStale(
  github: Pick<GitHubClient, "getDefaultBranch" | "getChangedPathsBetween">,
  owner: string,
  repo: string,
  repoDir: string,
): Promise<boolean> {
  if (!existsSync(join(repoDir, ".git"))) return false;
  const main = await github.getDefaultBranch(owner, repo);
  const base = git(repoDir, ["merge-base", "HEAD", `origin/${main}`]);
  const ours = new Set(
    [
      ...git(repoDir, ["diff", "--name-only", base]).split("\n"),
      ...git(repoDir, ["ls-files", "--others", "--exclude-standard"]).split("\n"),
    ].filter((p) => p && !p.startsWith(".lastlight/")),
  );
  if (ours.size === 0) return false;
  const moved = await github.getChangedPathsBetween(owner, repo, base, main);
  return moved === null || moved.some((p) => ours.has(p));
}

/**
 * On a retry/resume of a build: if the base is stale, delete the checkout (the
 * next phase re-clones from current main) and reopen the cached phases from
 * `executor` onward so they run again. Otherwise change nothing. Never throws —
 * a failed check must not fail the run, it just keeps today's behaviour.
 */
export async function discardStaleBuild(args: {
  db: StateDb;
  github: Pick<GitHubClient, "getDefaultBranch" | "getChangedPathsBetween">;
  runId: string;
  workflowName: string;
  phases: string[];
  owner: string;
  repo: string;
  repoDir: string;
}): Promise<boolean> {
  try {
    const from = args.phases.indexOf(REBUILD_FROM);
    if (from < 0 || !(await baseIsStale(args.github, args.owner, args.repo, args.repoDir))) return false;
    rmSync(args.repoDir, { recursive: true, force: true });
    const reopened = await args.db.executions.reopenPhases(
      args.runId,
      args.phases.slice(from).map((p) => `${args.workflowName}:${p}`),
    );
    log.info("Base moved onto this run's files — rebuilding from current main", { runId: args.runId, reopened });
    return true;
  } catch (err) {
    log.warn("Base-freshness check failed — resuming as before", { runId: args.runId, err });
    return false;
  }
}
