/**
 * `prompts/pr.md` arms GitHub auto-merge only for a build whose reviewer
 * approved. A review loop that ended on REQUEST_CHANGES (fix cycles exhausted)
 * still opens its PR, but must not hand it to auto-merge.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderTemplate, type TemplateContext } from "#src/workflows/templates.js";

const PR_PROMPT = readFileSync(new URL("../../workflows/prompts/pr.md", import.meta.url), "utf-8");

const BASE_CTX: TemplateContext = {
  owner: "acme",
  repo: "widgets",
  issueNumber: 7,
  issueTitle: "Add a rate limiter",
  issueBody: "",
  issueLabels: [],
  commentBody: "",
  sender: "alice",
  branch: "lastlight/7-rate-limiter",
  taskId: "widgets-7",
  issueDir: ".lastlight/issue-7",
  bootstrapLabel: "lastlight:bootstrap",
};

const autoMerge = { configured: "auto", effective: "auto", auto: true };
const noAutoMerge = { configured: "none", effective: "none", auto: false };

function render(autonomyMerge: object, review?: { approved: boolean; cycles: number }): string {
  return renderTemplate(PR_PROMPT, {
    ...BASE_CTX,
    autonomyMerge,
    ...(review ? { phaseOutputs: { review } } : {}),
  });
}

describe("prompts/pr.md — auto-merge requires an approved review", () => {
  it("arms auto-merge when the stage asks for it and the reviewer approved", () => {
    const out = render(autoMerge, { approved: true, cycles: 0 });
    expect(out).toContain("github_enable_auto_merge");
    expect(out).not.toContain("AUTO-MERGE WITHHELD");
  });

  it("does not arm auto-merge when the review loop ended in REQUEST_CHANGES", () => {
    const out = render(autoMerge, { approved: false, cycles: 2 });
    expect(out).not.toContain("AUTO-MERGE: this build ran");
    expect(out).toContain("AUTO-MERGE WITHHELD");
    expect(out).toContain("unresolved reviewer issues after 2 fix cycles");
  });

  it("does not arm auto-merge when no review verdict exists", () => {
    const out = render(autoMerge);
    expect(out).not.toContain("AUTO-MERGE: this build ran");
    expect(out).toContain("AUTO-MERGE WITHHELD");
  });

  it("says nothing about auto-merge when the stage did not ask for it", () => {
    for (const review of [{ approved: true, cycles: 0 }, { approved: false, cycles: 2 }]) {
      const out = render(noAutoMerge, review);
      expect(out).not.toContain("AUTO-MERGE");
    }
  });
});
