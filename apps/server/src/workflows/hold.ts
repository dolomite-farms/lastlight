import type { GitHubClient } from "../engine/github/github.js";
import { getHoldLabel } from "../config/config.js";
import { logger } from "../logging/logger.js";

const log = logger("workflow-hold");

/** Issue-label build workflows; PR and QA workflows intentionally keep running on held issues. */
export function isBuildFamilyWorkflow(workflowName: string): boolean {
  return workflowName === "build" || workflowName.startsWith("build-");
}

export function issueHoldCheck(
  github: GitHubClient | null,
  workflowName: string,
  owner: string,
  repo: string,
  issueNumber: number | undefined,
): (phase: string) => Promise<string | undefined> {
  return async (phase) => {
    if (!isBuildFamilyWorkflow(workflowName) || !github || typeof issueNumber !== "number") return undefined;
    try {
      const issue = await github.getIssue(owner, repo, issueNumber);
      const labels = (issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name ?? "");
      const holdLabel = getHoldLabel();
      return labels.includes(holdLabel) ? holdLabel : undefined;
    } catch (err: unknown) {
      log.warn("Could not re-read issue labels before phase; continuing the run", { workflowName, phase, err });
      return undefined;
    }
  };
}
