import { describe, it, expect, vi } from "vitest";
import { issueHoldCheck } from "#src/workflows/hold.js";

describe("issueHoldCheck", () => {
  it("honors lastlight-ignore for build workflows", async () => {
    const github = { getIssue: vi.fn(async () => ({ labels: [{ name: "lastlight-ignore" }] })) };
    const check = issueHoldCheck(github as never, "build-ui", "acme", "widgets", 3);

    await expect(check("reviewer_fix_1")).resolves.toBe("lastlight-ignore");
    expect(github.getIssue).toHaveBeenCalledWith("acme", "widgets", 3);
  });

  it.each(["pr-fix", "pr-review", "polar-rereview", "qa-test"])(
    "does not hold %s workflows", async (workflowName) => {
      const github = { getIssue: vi.fn() };
      const check = issueHoldCheck(github as never, workflowName, "acme", "widgets", 3);

      await expect(check("reviewer")).resolves.toBeUndefined();
      expect(github.getIssue).not.toHaveBeenCalled();
    },
  );

  it("continues when GitHub cannot read labels", async () => {
    const github = { getIssue: vi.fn(async () => { throw new Error("offline"); }) };
    const check = issueHoldCheck(github as never, "build", "acme", "widgets", 3);

    await expect(check("architect")).resolves.toBeUndefined();
  });
});
