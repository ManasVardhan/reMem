import { describe, expect, it } from "vitest";
import { parseMarketplaces, parsePluginInstalled } from "./probe.js";

describe("parseMarketplaces", () => {
  it("reads a GitHub source", () => {
    expect(
      parseMarketplaces(
        JSON.stringify([
          { name: "remem", source: "github", repo: "ManasVardhan/reMem" },
        ]),
      ),
    ).toBe("github:ManasVardhan/reMem");
  });
  it("reads a directory source", () => {
    expect(
      parseMarketplaces(
        JSON.stringify([
          { name: "remem", source: "directory", path: "/opt/x" },
        ]),
      ),
    ).toBe("directory:/opt/x");
  });
  it("never resolves a directory entry with no path to the cwd", () => {
    for (const entry of [
      { name: "remem", source: "directory" },
      { name: "remem", source: "directory", path: "" },
    ]) {
      const got = parseMarketplaces(JSON.stringify([entry]));
      expect(got).toBe("directory:<missing>");
      expect(got).not.toBe(`directory:${process.cwd()}`);
    }
  });
  it("marks a github entry with an empty repo as missing", () => {
    expect(
      parseMarketplaces(
        JSON.stringify([{ name: "remem", source: "github", repo: "" }]),
      ),
    ).toBe("github:<missing>");
  });
  it("is undefined when remem is absent", () => {
    expect(
      parseMarketplaces(
        JSON.stringify([{ name: "other", source: "github", repo: "a/b" }]),
      ),
    ).toBeUndefined();
  });
  it("is undefined on garbage instead of throwing", () => {
    expect(parseMarketplaces("not json")).toBeUndefined();
    expect(parseMarketplaces("")).toBeUndefined();
  });
});

describe("parsePluginInstalled", () => {
  it("finds remem@remem", () => {
    expect(parsePluginInstalled(JSON.stringify([{ id: "remem@remem" }]))).toBe(
      true,
    );
  });
  it("is false when absent or unparseable", () => {
    expect(parsePluginInstalled(JSON.stringify([{ id: "x@y" }]))).toBe(false);
    expect(parsePluginInstalled("{")).toBe(false);
  });
});

describe("parseMarketplaces, other source kinds", () => {
  it("reports an unknown kind verbatim so it never matches and gets replaced", () => {
    expect(
      parseMarketplaces(
        JSON.stringify([
          { name: "remem", source: "git", url: "https://x/y.git" },
        ]),
      ),
    ).toBe("git:https://x/y.git");
  });
});
