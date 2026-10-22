/**
 * A retried build replayed cached phases onto a branch that main had
 * since moved past, on the same files. On resume the harness now compares the
 * run's base with the default branch and, when main touched files the run also
 * changed, rebuilds from `executor` onward off current main.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("#src/engine/agent-executor.js", () => ({ executeAgent: vi.fn(), executeCommand: vi.fn() }));
vi.mock("#src/admin/docker.js", () => ({ listRunningContainers: vi.fn(async () => []) }));

import { executeAgent } from "#src/engine/agent-executor.js";
import type { StateDb } from "#src/state/db.js";
import { makeTestDb } from "../helpers/state-db.js";
import { configureWorkflowAssets, clearWorkflowCache } from "#src/workflows/loader.js";
import { __resetTargetPolicyCacheForTest } from "#src/workflows/target-policy.js";
import { resumeSimpleRun, type ResumeOptions } from "#src/workflows/resume.js";

const mockExecuteAgent = vi.mocked(executeAgent);

const YAML = `
name: build-ui
workspace: per-target-recreate
prepopulate_synth_branch: true
phases:
  - name: architect
    label: Architect
    prompt: prompts/p.md
  - name: executor
    label: Executor
    prompt: prompts/p.md
  - name: reviewer
    label: Reviewer
    prompt: prompts/p.md
`;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf-8" }).trim();

describe("resumeSimpleRun — stale base on retry", () => {
  let db: StateDb;
  let sandboxDir: string;
  let origin: string;
  let repoDir: string;

  beforeEach(async () => {
    const builtIn = mkdtempSync(join(tmpdir(), "stale-base-assets-"));
    mkdirSync(join(builtIn, "workflows", "prompts"), { recursive: true });
    writeFileSync(join(builtIn, "workflows", "build-ui.yaml"), YAML);
    writeFileSync(join(builtIn, "workflows", "prompts", "p.md"), "go");
    configureWorkflowAssets({ builtInRoot: builtIn });
    clearWorkflowCache();
    __resetTargetPolicyCacheForTest();
    db = await makeTestDb();
    mockExecuteAgent.mockResolvedValue({ success: true, output: "done", error: undefined, turns: 1, durationMs: 1 });

    // A real origin with a.txt and b.txt, and the run's checkout cut from it
    // with an executor commit that edits a.txt.
    const root = mkdtempSync(join(tmpdir(), "stale-base-git-"));
    origin = join(root, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    writeFileSync(join(origin, "a.txt"), "1\n");
    writeFileSync(join(origin, "b.txt"), "1\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "base");
    sandboxDir = join(root, "sandboxes");
    repoDir = join(sandboxDir, "widgets-7-build", "widgets");
    mkdirSync(join(sandboxDir, "widgets-7-build"), { recursive: true });
    execFileSync("git", ["clone", "-q", origin, repoDir]);
    git(repoDir, "checkout", "-qb", "lastlight/7-x");
    writeFileSync(join(repoDir, "a.txt"), "executor edit\n");
    git(repoDir, "commit", "-qam", "executor");

    await db.runs.createRun({
      id: "run-1", workflowName: "build-ui", triggerId: "acme/widgets#7", owner: "acme", repo: "widgets",
      issueNumber: 7, currentPhase: "reviewer", status: "running",
      context: { kind: "agent", taskId: "widgets-7-build", branch: "lastlight/7-x", issueDir: ".lastlight/issue-7" },
      startedAt: new Date().toISOString(),
    });
    for (const phase of ["architect", "executor"]) {
      const id = `ex-${phase}`;
      await db.executions.recordStart({
        id, triggerType: "issue", triggerId: "acme/widgets#7", skill: `build-ui:${phase}`,
        startedAt: new Date().toISOString(), workflowRunId: "run-1", owner: "acme", repo: "widgets",
      } as never);
      await db.executions.recordFinish(id, { success: true });
    }
  });

  afterEach(() => {
    configureWorkflowAssets();
    clearWorkflowCache();
    __resetTargetPolicyCacheForTest();
    vi.clearAllMocks();
  });

  /** Main moves by editing `file`; the fake GitHub answers from the real origin repo. */
  const resume = (movedFile: string | null) => {
    if (movedFile) {
      writeFileSync(join(origin, movedFile), "main moved\n");
      git(origin, "commit", "-qam", "main moves");
    }
    const github = {
      getDefaultBranch: async () => "main",
      getChangedPathsBetween: async (_o: string, _r: string, base: string, head: string) =>
        git(origin, "diff", "--name-only", base, head).split("\n").filter(Boolean),
    };
    const opts = {
      db, github, models: { default: "m" }, variants: {}, approvalConfig: {},
      config: { model: "m", stateDir: "/tmp", sandboxDir, sessionsDir: "/tmp/sessions", sandbox: "none", buildAssets: "repo" },
    } as unknown as ResumeOptions;
    return async () => resumeSimpleRun((await db.runs.getRun("run-1"))!, opts);
  };

  it("main moved onto the files the run changed: discards the checkout and re-runs executor onward", async () => {
    await resume("a.txt")();
    expect(existsSync(repoDir)).toBe(false);
    // architect stays cached; executor and reviewer both ran again.
    expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
  });

  it("main moved only on other files: keeps today's behaviour, skips what succeeded", async () => {
    await resume("b.txt")();
    expect(existsSync(repoDir)).toBe(true);
    expect(mockExecuteAgent).toHaveBeenCalledTimes(1); // only the reviewer
  });

  it("main has not moved: keeps today's behaviour", async () => {
    await resume(null)();
    expect(existsSync(repoDir)).toBe(true);
    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
  });
});
