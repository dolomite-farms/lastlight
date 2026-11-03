import { describe, it, expect } from "vitest";
import { keptSandboxesToRemove, KEEP_FAILED_MS } from "#src/sandbox/docker.js";

describe("keptSandboxesToRemove", () => {
  const now = 1_000_000_000_000;
  const name = (id: string, expires: number) => `lastlight-sandbox-${id}-kept-${expires}`;

  it("removes expired sandboxes and leaves live ones", () => {
    const fresh = name("a", now + KEEP_FAILED_MS);
    const old = name("b", now - 1);
    expect(keptSandboxesToRemove([fresh, old], now)).toEqual([old]);
  });

  it("keeps only the newest three", () => {
    const names = [1, 2, 3, 4].map((i) => name(String(i), now + i * 1000));
    expect(keptSandboxesToRemove(names, now)).toEqual([names[0]]);
  });

  it("ignores containers that are not kept sandboxes", () => {
    expect(keptSandboxesToRemove(["lastlight-sandbox-x-1234"], now)).toEqual([]);
  });
});
