import { afterEach, expect, it, vi } from "vitest";
import { GitHubClient } from "#src/engine/github/github.js";

afterEach(() => vi.unstubAllGlobals());

const pr = (number: number, ref: string, fullName: string, extra: object = {}) => ({
  number,
  state: "open",
  head: { ref, repo: { full_name: fullName } },
  ...extra,
});

it("finds the same-repository PR for a branch in any state, ignoring fork lookalikes", async () => {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    Response.json([
      pr(1, "other", "acme/widgets"),
      pr(2, "lastlight/7-fix", "someone/widgets"),
      pr(3, "lastlight/7-fix", "Acme/Widgets", { state: "closed", merged_at: "2026-01-01T00:00:00Z" }),
    ]),
  );
  vi.stubGlobal("fetch", fetch);
  const client = GitHubClient.withToken("test", "http://github.invalid");

  expect((await client.findPullRequestByHead("acme", "widgets", "lastlight/7-fix"))?.number).toBe(3);
  const url = new URL(String(fetch.mock.calls[0]![0]));
  expect(url.searchParams.get("state")).toBe("all");
  expect(url.searchParams.get("head")).toBe("acme:lastlight/7-fix");
});

it("returns undefined when no PR was opened from the branch", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
  const client = GitHubClient.withToken("test", "http://github.invalid");
  expect(await client.findPullRequestByHead("acme", "widgets", "missing")).toBeUndefined();
});
