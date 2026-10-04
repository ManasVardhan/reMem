import { describe, expect, it } from "vitest";
import { parseArgs, shellArgs, timeoutFor } from "./args.js";

describe("parseArgs", () => {
  it("accepts setup with and without --dry-run", () => {
    expect(parseArgs(["setup"])).toEqual({ kind: "setup", dryRun: false });
    expect(parseArgs(["setup", "--dry-run"])).toEqual({
      kind: "setup",
      dryRun: true,
    });
  });
  it("rejects an unknown argument to setup instead of installing", () => {
    expect(parseArgs(["setup", "--dryrun"])).toEqual({
      kind: "usage-error",
      message: "unknown argument to setup: --dryrun",
    });
    expect(parseArgs(["setup", "--dry-run", "extra"]).kind).toBe("usage-error");
  });
  it("reports an unknown command as a usage error", () => {
    expect(parseArgs(["instal"])).toEqual({
      kind: "usage-error",
      message: "unknown command: instal",
    });
  });
  it("passes doctor arguments through and handles help and version", () => {
    expect(parseArgs(["doctor", "--json"])).toEqual({
      kind: "doctor",
      args: ["--json"],
    });
    expect(parseArgs([]).kind).toBe("help");
    expect(parseArgs(["--help"]).kind).toBe("help");
    expect(parseArgs(["-v"]).kind).toBe("version");
  });
});

describe("timeoutFor", () => {
  it("gives npm install ten minutes and everything else two", () => {
    expect(timeoutFor("npm", ["install", "--prefix", "x"])).toBe(600_000);
    expect(timeoutFor("npm", ["--version"])).toBe(120_000);
    expect(timeoutFor("claude", ["plugin", "list"])).toBe(120_000);
  });
});

describe("shellArgs", () => {
  it("quotes only arguments containing whitespace", () => {
    expect(shellArgs(["install", "C:\\Users\\A B\\rt"])).toEqual([
      "install",
      '"C:\\Users\\A B\\rt"',
    ]);
  });
});
