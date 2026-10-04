import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import { dbPath, projectScope, projectPath } from "./store.js";

const originalDb = process.env.REMEM_DB;
const originalProject = process.env.REMEM_PROJECT;

afterEach(() => {
  if (originalDb === undefined) delete process.env.REMEM_DB;
  else process.env.REMEM_DB = originalDb;
  if (originalProject === undefined) delete process.env.REMEM_PROJECT;
  else process.env.REMEM_PROJECT = originalProject;
});

describe("store location", () => {
  it("defaults to a single shared store under the home directory", () => {
    delete process.env.REMEM_DB;
    expect(dbPath()).toBe(join(homedir(), ".remem", "remem.db"));
  });

  it("honours REMEM_DB so tests and relocations do not touch real memory", () => {
    process.env.REMEM_DB = "/tmp/somewhere/remem.db";
    expect(dbPath()).toBe("/tmp/somewhere/remem.db");
  });

  it("ignores a blank override rather than opening an empty path", () => {
    process.env.REMEM_DB = "   ";
    expect(dbPath()).toBe(join(homedir(), ".remem", "remem.db"));
  });
});

describe("project scope", () => {
  it("is the project name, so a belief survives the repository moving", () => {
    expect(projectScope("/repo/x")).toBe("x");
    expect(projectScope("/Users/someone/code/reMem")).toBe("reMem");
  });

  it("handles windows separators and trailing slashes", () => {
    expect(projectScope("C:\\code\\widget")).toBe("widget");
    expect(projectScope("/repo/x/")).toBe("x");
  });

  it("prefers an explicit argument, then REMEM_PROJECT, then cwd", () => {
    expect(projectScope("/repo/x")).toBe("x");
    process.env.REMEM_PROJECT = "/repo/env";
    expect(projectScope()).toBe("env");
    delete process.env.REMEM_PROJECT;
    expect(projectScope()).toBe(projectScope(process.cwd()));
  });

  it("treats blank as absent, which means the belief holds anywhere", () => {
    expect(projectScope("   ")).toBeUndefined();
    expect(projectPath("   ")).toBeUndefined();
  });

  it("keeps the full path available separately", () => {
    expect(projectPath("/repo/x")).toBe("/repo/x");
  });
});
