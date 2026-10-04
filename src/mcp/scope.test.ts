import { describe, it, expect } from "vitest";
import { inScopeByConfidence } from "./scope.js";

const b = (project: string | undefined, confidence: number, tag: string) => ({
  scope: project === undefined ? {} : { project },
  effectiveConfidence: confidence,
  tag,
});

describe("session-start scope filtering", () => {
  it("includes unscoped beliefs, which hold anywhere", () => {
    const got = inScopeByConfidence(
      [b(undefined, 0.8, "global")],
      "/repo/a",
      10,
    );
    expect(got.map((x) => x.tag)).toEqual(["global"]);
  });

  it("includes beliefs scoped to this project", () => {
    const got = inScopeByConfidence([b("/repo/a", 0.9, "mine")], "/repo/a", 10);
    expect(got.map((x) => x.tag)).toEqual(["mine"]);
  });

  it("excludes beliefs belonging to another project", () => {
    const got = inScopeByConfidence(
      [b("/repo/other", 0.99, "theirs")],
      "/repo/a",
      10,
    );
    expect(got).toEqual([]);
  });

  it("excludes other projects even when the session has no project", () => {
    const got = inScopeByConfidence(
      [b("/repo/other", 0.99, "theirs"), b(undefined, 0.5, "global")],
      undefined,
      10,
    );
    expect(got.map((x) => x.tag)).toEqual(["global"]);
  });

  it("orders by confidence so the strongest beliefs survive the cap", () => {
    const got = inScopeByConfidence(
      [
        b(undefined, 0.4, "low"),
        b(undefined, 0.95, "high"),
        b(undefined, 0.7, "mid"),
      ],
      "/repo/a",
      2,
    );
    expect(got.map((x) => x.tag)).toEqual(["high", "mid"]);
  });
});
