/**
 * The terminal stage label follows the review result.
 *
 * A succeeded build is not necessarily a clean one: a reviewer loop that ran out
 * of fix cycles still on REQUEST_CHANGES opens its PR and succeeds. And with
 * `on_merge: auto` an APPROVED build has nothing left for a human to do. A stage
 * that configures `on_auto_merge` routes exactly that case — approved by the
 * LAST review, and the PR actually on auto-merge — to its own label; every other
 * success keeps `on_success`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { installStageObserver } from "#src/engine/stage-observer.js";
import { loadConfig, resetRuntimeConfigForTests } from "#src/config/config.js";
import { STAGE_READY_FOR_HUMAN } from "#src/engine/stage-labels.js";
import { makeTestDb } from "../helpers/state-db.js";
import type { StateDb } from "#src/state/db.js";
import type { GitHubClient } from "#src/engine/github/github.js";

vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

const OWNER = "acme";
const NAME = "widgets";
const REPO = `${OWNER}/${NAME}`;
const ISSUE = 7;
const BRANCH = "lastlight/7-rate-limiter";
const AUTO_MERGE_LABEL = "agent-pr-open";

type PullRequest = { number: number; auto_merge: object | null; merged_at: string | null };

function fakeGithub(pr: PullRequest | undefined | Error) {
  const addLabels = vi.fn(async () => {});
  const removeLabel = vi.fn(async () => {});
  const findPullRequestByHead = vi.fn(async () => {
    if (pr instanceof Error) throw pr;
    return pr;
  });
  return { addLabels, removeLabel, findPullRequestByHead } as unknown as GitHubClient & {
    addLabels: ReturnType<typeof vi.fn>;
    findPullRequestByHead: ReturnType<typeof vi.fn>;
  };
}

const ARMED: PullRequest = { number: 9, auto_merge: { merge_method: "squash" }, merged_at: null };
const MERGED: PullRequest = { number: 9, auto_merge: null, merged_at: "2026-01-01T00:00:00Z" };
const PARKED: PullRequest = { number: 9, auto_merge: null, merged_at: null };

/** The review rows a build persists, in order: the first review, then each fix and re-check. */
const APPROVED_FIRST = [{ phase: "reviewer", summary: "APPROVED" }];
const APPROVED_AFTER_FIX = [
  { phase: "reviewer", summary: "REQUEST_CHANGES" },
  { phase: "reviewer_fix_1" },
  { phase: "reviewer_recheck_1", summary: "APPROVED" },
];
const EXHAUSTED = [
  { phase: "reviewer", summary: "REQUEST_CHANGES" },
  { phase: "reviewer_fix_1" },
  { phase: "reviewer_recheck_1", summary: "REQUEST_CHANGES" },
  { phase: "reviewer_fix_2" },
  { phase: "reviewer_recheck_2", summary: "REQUEST_CHANGES — max cycles reached" },
];

describe("stage observer — on_auto_merge", () => {
  let db: StateDb;

  function configure(stage: string) {
    const dir = mkdtempSync(join(tmpdir(), "stage-observer-auto-merge-"));
    writeFileSync(join(dir, "config.yaml"), `autonomy:\n  repos:\n    - "${REPO}"\n  stages:\n    build:\n${stage}`);
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", dir);
    loadConfig();
  }

  const AUTO = `      on_merge: auto\n      on_auto_merge: ${AUTO_MERGE_LABEL}\n`;

  beforeEach(async () => {
    db = await makeTestDb();
    for (const k of ["GITHUB_APP_ID", "SLACK_BOT_TOKEN", "LASTLIGHT_MODEL", "LASTLIGHT_MODELS"]) {
      vi.stubEnv(k, "");
    }
    configure(AUTO);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  async function finish(
    reviews: Array<{ phase: string; summary?: string }>,
    pr: PullRequest | undefined | Error,
    context: Record<string, unknown> = { _stage: "build", _autonomous: true, branch: BRANCH },
  ) {
    const github = fakeGithub(pr);
    installStageObserver(db, { github });
    await db.runs.createRun({
      id: "run-1",
      workflowName: "build",
      triggerId: `${REPO}#${ISSUE}`,
      owner: OWNER,
      repo: NAME,
      issueNumber: ISSUE,
      currentPhase: "complete",
      status: "running",
      context,
      startedAt: new Date().toISOString(),
    });
    for (const entry of [...reviews, { phase: "pr" }, { phase: "complete" }]) {
      await db.runs.appendPhase("run-1", entry.phase, {
        phase: entry.phase,
        timestamp: new Date().toISOString(),
        success: true,
        ...("summary" in entry ? { summary: entry.summary } : {}),
      });
    }
    await db.runs.finishRun("run-1", "succeeded");
    await new Promise((r) => setImmediate(r));
    return github;
  }

  const landedOn = (github: { addLabels: ReturnType<typeof vi.fn> }) =>
    github.addLabels.mock.calls.map((c) => c[3]);

  it("approved on the first review, PR on auto-merge: the auto-merge label", async () => {
    const github = await finish(APPROVED_FIRST, ARMED);
    expect(landedOn(github)).toEqual([[AUTO_MERGE_LABEL]]);
    expect(github.findPullRequestByHead).toHaveBeenCalledWith(OWNER, NAME, BRANCH);
  });

  it("approved by a re-check after a fix cycle: the auto-merge label", async () => {
    expect(landedOn(await finish(APPROVED_AFTER_FIX, ARMED))).toEqual([[AUTO_MERGE_LABEL]]);
  });

  it("approved and already merged: the auto-merge label", async () => {
    expect(landedOn(await finish(APPROVED_FIRST, MERGED))).toEqual([[AUTO_MERGE_LABEL]]);
  });

  it("review loop exhausted on REQUEST_CHANGES: stays on the success label for a human", async () => {
    const github = await finish(EXHAUSTED, ARMED);
    expect(landedOn(github)).toEqual([[STAGE_READY_FOR_HUMAN]]);
    expect(github.findPullRequestByHead).not.toHaveBeenCalled();
  });

  it("an earlier approval cannot outlive a later REQUEST_CHANGES", async () => {
    const reviews = [...APPROVED_FIRST, { phase: "reviewer_recheck_1", summary: "REQUEST_CHANGES" }];
    expect(landedOn(await finish(reviews, ARMED))).toEqual([[STAGE_READY_FOR_HUMAN]]);
  });

  it("no review verdict at all: stays on the success label", async () => {
    expect(landedOn(await finish([], ARMED))).toEqual([[STAGE_READY_FOR_HUMAN]]);
  });

  it("approved but the PR was left parked (auto-merge could not be armed): success label", async () => {
    expect(landedOn(await finish(APPROVED_FIRST, PARKED))).toEqual([[STAGE_READY_FOR_HUMAN]]);
  });

  it("approved but no PR found for the branch: success label", async () => {
    expect(landedOn(await finish(APPROVED_FIRST, undefined))).toEqual([[STAGE_READY_FOR_HUMAN]]);
  });

  it("approved but the run recorded no branch: success label, no lookup", async () => {
    const github = await finish(APPROVED_FIRST, ARMED, { _stage: "build", _autonomous: true });
    expect(landedOn(github)).toEqual([[STAGE_READY_FOR_HUMAN]]);
    expect(github.findPullRequestByHead).not.toHaveBeenCalled();
  });

  it("a failing GitHub read fails toward a human", async () => {
    expect(landedOn(await finish(APPROVED_FIRST, new Error("GitHub unavailable")))).toEqual([
      [STAGE_READY_FOR_HUMAN],
    ]);
  });

  it("without on_merge: auto the label is never consulted", async () => {
    configure(`      on_auto_merge: ${AUTO_MERGE_LABEL}\n`);
    const github = await finish(APPROVED_FIRST, ARMED);
    expect(landedOn(github)).toEqual([[STAGE_READY_FOR_HUMAN]]);
    expect(github.findPullRequestByHead).not.toHaveBeenCalled();
  });

  it("without on_auto_merge configured (the default) nothing changes", async () => {
    configure("      on_merge: auto\n");
    const github = await finish(APPROVED_FIRST, ARMED);
    expect(landedOn(github)).toEqual([[STAGE_READY_FOR_HUMAN]]);
    expect(github.findPullRequestByHead).not.toHaveBeenCalled();
  });
});
