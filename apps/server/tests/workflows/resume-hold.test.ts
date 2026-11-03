import { describe, it, expect, vi } from "vitest";

vi.mock("#src/engine/agent-executor.js", () => ({ executeAgent: vi.fn(), executeCommand: vi.fn() }));
vi.mock("#src/admin/docker.js", () => ({ listRunningContainers: vi.fn(async () => []) }));

import { executeAgent } from "#src/engine/agent-executor.js";
import type { StateDb } from "#src/state/db.js";
import { makeTestDb } from "../helpers/state-db.js";
import { resumeSimpleRun, type ResumeOptions } from "#src/workflows/resume.js";

describe("resumeSimpleRun issue hold", () => {
  it("checks the hold before executing a recovered build phase", async () => {
    const db = await makeTestDb();
    await db.runs.createRun({
      id: "held-build",
      workflowName: "build",
      triggerId: "acme/widgets#8",
      owner: "acme",
      repo: "widgets",
      issueNumber: 8,
      currentPhase: "architect",
      status: "running",
      context: {
        kind: "agent",
        owner: "acme",
        repo: "widgets",
        taskId: "widgets-8-build",
        issueDir: ".lastlight/issue-8",
        branch: "lastlight/8-test",
      },
      startedAt: new Date().toISOString(),
    });
    const github = {
      getIssue: vi.fn(async () => ({
        title: "Held build",
        body: "",
        labels: [{ name: "lastlight-ignore" }],
      })),
    };
    const opts = {
      db,
      github,
      config: {
        model: "test",
        maxTurns: 3,
        stateDir: "/tmp",
        sandboxDir: "/tmp/sandboxes",
        sessionsDir: "/tmp/sessions",
        sandbox: "none",
        buildAssets: "repo",
        buildAssetsDir: "/tmp/build-assets",
      },
    } as unknown as ResumeOptions;

    await resumeSimpleRun((await db.runs.getRun("held-build"))!, opts);

    expect(github.getIssue).toHaveBeenCalled();
    expect(vi.mocked(executeAgent)).not.toHaveBeenCalled();
    expect((await db.runs.getRun("held-build"))!.status).toBe("cancelled");
  });
});
