import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, execFileSync: vi.fn().mockReturnValue(""), execFile: vi.fn(), spawn: vi.fn() };
});
vi.mock("#src/logging/logger.js", () => {
  const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: () => noopLogger };
  return { logger: () => noopLogger };
});

import { execFileSync } from "child_process";
import { DockerSandbox, keptSandboxesToRemove } from "#src/sandbox/docker.js";
import { cleanupOrphanedSandboxes } from "#src/sandbox/index.js";

const mockExecFileSync = vi.mocked(execFileSync);
const HOUR = 3_600_000;

describe("keptSandboxesToRemove", () => {
  const now = 1_000_000_000_000;
  const name = (id: string, expires: number) => `lastlight-sandbox-${id}-kept-${expires}`;

  it("removes expired sandboxes and leaves live ones", () => {
    const fresh = name("a", now + HOUR);
    const old = name("b", now - 1);
    expect(keptSandboxesToRemove([fresh, old], now, 3)).toEqual([old]);
  });

  it.each([
    [1, 3],
    [2, 2],
    [3, 1],
    [10, 0],
  ])("with max=%i removes the %i oldest of four", (max, removed) => {
    const names = [1, 2, 3, 4].map((i) => name(String(i), now + i * 1000));
    const doomed = keptSandboxesToRemove(names, now, max);
    expect(doomed).toHaveLength(removed);
    // The survivors are always the newest by expiry.
    expect([...doomed].sort()).toEqual(names.slice(0, removed).sort());
  });

  it("ignores containers that are not kept lastlight sandboxes", () => {
    expect(
      keptSandboxesToRemove(["lastlight-sandbox-x-1234", "someone-elses-kept-1", "web-kept-5"], now, 0),
    ).toEqual([]);
  });
});

describe("DockerSandbox.keepForInspection", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset().mockReturnValue("");
  });

  const track = (sandbox: DockerSandbox) =>
    (sandbox as unknown as { activeContainers: Map<string, unknown> }).activeContainers.set("t1", {
      containerId: "c1",
      containerName: "lastlight-sandbox-t1-abc",
      worktreePath: "/w",
    });
  // The per-task service lookup (`stopServices`) runs on every teardown; it is not under test.
  const dockerCalls = () =>
    mockExecFileSync.mock.calls.map((c) => (c[1] as string[]).join(" ")).filter((c) => !c.includes("lastlight.taskId"));

  it("is off by default: runs no docker command and reports not kept", async () => {
    const sandbox = new DockerSandbox({ imageName: "img", env: {} });
    track(sandbox);
    expect(await sandbox.keepForInspection("t1")).toBe(false);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("does nothing when hours is 0", async () => {
    const sandbox = new DockerSandbox({ imageName: "img", env: {}, keepFailed: { hours: 0, max: 3 } });
    track(sandbox);
    expect(await sandbox.keepForInspection("t1")).toBe(false);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("pauses and renames with the configured expiry, then sweeps", async () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000);
    const sandbox = new DockerSandbox({ imageName: "img", env: {}, keepFailed: { hours: 2, max: 3 } });
    track(sandbox);
    expect(await sandbox.keepForInspection("t1")).toBe(true);
    const calls = dockerCalls();
    expect(calls[0]).toBe("pause lastlight-sandbox-t1-abc");
    expect(calls[1]).toBe(`rename lastlight-sandbox-t1-abc lastlight-sandbox-t1-abc-kept-${5_000 + 2 * HOUR}`);
    expect(calls[2]).toContain("ps -a --filter name=lastlight-sandbox-");
    vi.restoreAllMocks();
  });

  it("reports not kept when docker refuses (so the caller destroys it)", async () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      if ((args as string[])[0] === "pause") throw new Error("container is not running");
      return "";
    });
    const sandbox = new DockerSandbox({ imageName: "img", env: {}, keepFailed: { hours: 2, max: 3 } });
    track(sandbox);
    expect(await sandbox.keepForInspection("t1")).toBe(false);
  });

  it("destroy does not sweep while keeping is off", async () => {
    const sandbox = new DockerSandbox({ imageName: "img", env: {} });
    track(sandbox);
    await sandbox.destroy("t1");
    expect(dockerCalls().every((c) => c.startsWith("rm -f"))).toBe(true);
  });
});

describe("cleanupOrphanedSandboxes", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it("leaves unexpired kept sandboxes alone and removes expired ones with the orphans", () => {
    const now = Date.now();
    mockExecFileSync.mockReturnValueOnce(
      [
        "id1 lastlight-sandbox-a-1",
        `id2 lastlight-sandbox-b-2-kept-${now + HOUR}`,
        `id3 lastlight-sandbox-c-3-kept-${now - HOUR}`,
      ].join("\n"),
    );
    cleanupOrphanedSandboxes();
    const rm = mockExecFileSync.mock.calls.find((c) => (c[1] as string[])[0] === "rm");
    expect(rm?.[1]).toEqual(["rm", "-f", "id1", "id3"]);
  });
});
