import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pinKernel } from "./pin.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "remem-pin-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeKernel(root: string): void {
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "index.js"), "");
}

describe("pinKernel", () => {
  it("overwrites a pointer left by an older global install", () => {
    const cache = join(dir, ".remem", "kernel-path.json");
    const global = join(dir, "global", "remem-kernel");
    const runtime = join(
      dir,
      ".remem",
      "runtime",
      "node_modules",
      "remem-kernel",
    );
    fakeKernel(global);
    fakeKernel(runtime);
    mkdirSync(join(dir, ".remem"), { recursive: true });
    writeFileSync(cache, JSON.stringify({ root: global }));

    expect(pinKernel(cache, runtime)).toBeUndefined();
    expect(JSON.parse(readFileSync(cache, "utf8"))).toEqual({ root: runtime });
  });
  it("replaces a cached miss, which the hooks would otherwise trust for a minute", () => {
    const cache = join(dir, "kernel-path.json");
    const runtime = join(dir, "rt", "node_modules", "remem-kernel");
    fakeKernel(runtime);
    writeFileSync(cache, JSON.stringify({ missAt: Date.now() }));

    expect(pinKernel(cache, runtime)).toBeUndefined();
    expect(JSON.parse(readFileSync(cache, "utf8"))).toEqual({ root: runtime });
  });
  it("refuses to point at a directory with no built kernel, leaving the cache alone", () => {
    const cache = join(dir, "kernel-path.json");
    writeFileSync(cache, JSON.stringify({ root: "/old" }));

    expect(pinKernel(cache, join(dir, "empty"))).toMatch(/dist\/index\.js/);
    expect(JSON.parse(readFileSync(cache, "utf8"))).toEqual({ root: "/old" });
  });
});
