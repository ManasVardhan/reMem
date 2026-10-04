import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSetup } from "./run.js";
import type { Exec } from "./probe.js";

function fakeExec(
  responses: Record<string, { code: number; stdout?: string; stderr?: string }>,
) {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    const hit = Object.entries(responses).find(([k]) => key.startsWith(k));
    const r = hit?.[1] ?? { code: 0 };
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { exec, calls };
}
const base = {
  runtimeDir: "/tmp/rt",
  source: "ManasVardhan/reMem",
  version: "0.3.0",
  doctor: async () => ({ status: "ok" as const }),
  pinKernel: () => undefined,
};
const empty = {
  "claude plugin marketplace list": { code: 0, stdout: "[]" },
  "claude plugin list": { code: 0, stdout: "[]" },
};

describe("runSetup", () => {
  it("dry run executes nothing beyond probes", async () => {
    const { exec, calls } = fakeExec({
      "claude plugin marketplace list": { code: 0, stdout: "[]" },
      "claude plugin list": { code: 0, stdout: "[]" },
    });
    const r = await runSetup({ ...base, exec, dryRun: true });
    expect(r.code).toBe(0);
    expect(
      calls.every((c) => c.includes("--version") || c.includes(" list")),
    ).toBe(true);
    expect(r.lines.join("\n")).toContain("claude plugin install remem@remem");
  });
  it("substitutes the runtime dir into the npm step", async () => {
    const { exec, calls } = fakeExec({
      "claude plugin marketplace list": { code: 0, stdout: "[]" },
      "claude plugin list": { code: 0, stdout: "[]" },
    });
    await runSetup({ ...base, exec, dryRun: false });
    expect(calls).toContain(
      "npm install --prefix /tmp/rt --no-audit --no-fund remem-kernel@0.3.0",
    );
  });
  it("falls back to stdout when a failing command writes no stderr", async () => {
    const { exec } = fakeExec({
      "claude plugin marketplace list": { code: 0, stdout: "[]" },
      "claude plugin list": { code: 0, stdout: "[]" },
      "claude plugin marketplace add": {
        code: 1,
        stdout: "Error: marketplace not found\nsecond line",
        stderr: "",
      },
    });
    const r = await runSetup({ ...base, exec, dryRun: false });
    expect(r.code).toBe(1);
    expect(r.lines).toContain("    Error: marketplace not found");
  });
  it("stops at the first failing command with exit 1 and its stderr", async () => {
    const { exec, calls } = fakeExec({
      "claude plugin marketplace list": { code: 0, stdout: "[]" },
      "claude plugin list": { code: 0, stdout: "[]" },
      "claude plugin marketplace add": { code: 1, stderr: "could not clone" },
    });
    const r = await runSetup({ ...base, exec, dryRun: false });
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toContain("could not clone");
    expect(calls.some((c) => c.startsWith("claude plugin install"))).toBe(
      false,
    );
  });
  it("exits 1 when doctor fails, 0 when it warns", async () => {
    const mk = () =>
      fakeExec({
        "claude plugin marketplace list": { code: 0, stdout: "[]" },
        "claude plugin list": { code: 0, stdout: "[]" },
      }).exec;
    expect(
      (
        await runSetup({
          ...base,
          exec: mk(),
          dryRun: false,
          doctor: async () => ({ status: "fail" }),
        })
      ).code,
    ).toBe(1);
    expect(
      (
        await runSetup({
          ...base,
          exec: mk(),
          dryRun: false,
          doctor: async () => ({ status: "warn" }),
        })
      ).code,
    ).toBe(0);
  });
  it("fails cleanly when claude is missing", async () => {
    const { exec } = fakeExec({ "claude --version": { code: 127 } });
    const r = await runSetup({ ...base, exec, dryRun: false });
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/claude/i);
  });
});

describe("runSetup kernel pointer", () => {
  it("points the hooks at the runtime kernel after the npm step, before doctor", async () => {
    const order: string[] = [];
    const { exec } = fakeExec(empty);
    const r = await runSetup({
      ...base,
      exec: async (cmd, args) => {
        order.push(cmd);
        return exec(cmd, args);
      },
      dryRun: false,
      pinKernel: (root) => {
        order.push(`pin ${root}`);
        return undefined;
      },
      doctor: async () => {
        order.push("doctor");
        return { status: "ok" };
      },
    });
    expect(r.code).toBe(0);
    const pin = order.indexOf("pin /tmp/rt/node_modules/remem-kernel");
    expect(pin).toBeGreaterThan(order.lastIndexOf("npm"));
    expect(order.indexOf("doctor")).toBeGreaterThan(pin);
  });
  it("pins even when the runtime kernel was already current", async () => {
    const pinned: string[] = [];
    const { exec, calls } = fakeExec({
      "claude plugin marketplace list": {
        code: 0,
        stdout: JSON.stringify([
          { name: "remem", source: "github", repo: "ManasVardhan/reMem" },
        ]),
      },
      "claude plugin list": {
        code: 0,
        stdout: JSON.stringify([{ id: "remem@remem" }]),
      },
    });
    // A runtime that already holds the wanted version, so no npm step runs.
    const rt = mkdtempSync(join(tmpdir(), "remem-run-"));
    const pkgDir = join(rt, "node_modules", "remem-kernel");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), '{"version":"0.3.0"}');
    const r = await runSetup({
      ...base,
      runtimeDir: rt,
      exec,
      dryRun: false,
      pinKernel: (root) => {
        pinned.push(root);
        return undefined;
      },
    });
    rmSync(rt, { recursive: true, force: true });
    expect(r.code).toBe(0);
    expect(calls).toContain("claude plugin update remem@remem");
    expect(calls.some((c) => c.startsWith("npm install"))).toBe(false);
    expect(pinned).toEqual([pkgDir]);
  });
  it("does not write the pointer in a dry run", async () => {
    let pinned = false;
    const { exec } = fakeExec(empty);
    const r = await runSetup({
      ...base,
      exec,
      dryRun: true,
      pinKernel: () => {
        pinned = true;
        return undefined;
      },
    });
    expect(r.code).toBe(0);
    expect(pinned).toBe(false);
    expect(r.lines.join("\n")).toContain("point the plugin's hooks at");
  });
  it("exits 1 when the pointer cannot be written, and never runs doctor", async () => {
    let doctored = false;
    const { exec } = fakeExec(empty);
    const r = await runSetup({
      ...base,
      exec,
      dryRun: false,
      pinKernel: () => "no kernel at /tmp/rt/node_modules/remem-kernel",
      doctor: async () => {
        doctored = true;
        return { status: "ok" };
      },
    });
    expect(r.code).toBe(1);
    expect(doctored).toBe(false);
    expect(r.lines.join("\n")).toContain("npx remem-kernel@latest setup");
  });
});

describe("runSetup version skew", () => {
  const skewed = {
    status: "warn" as const,
    kernel: {
      root: "/opt/homebrew/lib/node_modules/remem-kernel",
      version: "0.2.1",
    },
    plugin: { version: "0.3.0" },
  };
  it("exits 1 with an accurate message when doctor reports skew", async () => {
    const { exec } = fakeExec(empty);
    const r = await runSetup({
      ...base,
      exec,
      dryRun: false,
      doctor: async () => skewed,
    });
    expect(r.code).toBe(1);
    const text = r.lines.join("\n");
    expect(text).toContain(
      "the plugin is 0.3.0 but the hooks load kernel 0.2.1",
    );
    expect(text).toContain("npx remem-kernel@latest setup");
    expect(text).not.toContain("Restart Claude Code to load reMem.");
  });
  it("exits 0 when plugin and kernel match, even with other warnings", async () => {
    const { exec } = fakeExec(empty);
    const r = await runSetup({
      ...base,
      exec,
      dryRun: false,
      doctor: async () => ({
        status: "warn",
        kernel: { root: "/tmp/rt/node_modules/remem-kernel", version: "0.3.0" },
        plugin: { version: "0.3.0" },
      }),
    });
    expect(r.code).toBe(0);
  });
  it("only notes skew when REMEM_SETUP_VERSION chose the kernel", async () => {
    const { exec } = fakeExec(empty);
    const r = await runSetup({
      ...base,
      exec,
      dryRun: false,
      versionOverridden: true,
      doctor: async () => skewed,
    });
    expect(r.code).toBe(0);
    expect(r.lines.join("\n")).toContain("as REMEM_SETUP_VERSION asked");
  });
});

describe("runSetup onLine", () => {
  it("streams every line it returns, in order", async () => {
    const { exec } = fakeExec({
      "claude plugin marketplace list": { code: 0, stdout: "[]" },
      "claude plugin list": { code: 0, stdout: "[]" },
    });
    const seen: string[] = [];
    const r = await runSetup({
      ...base,
      exec,
      dryRun: true,
      onLine: (l) => seen.push(l),
    });
    expect(seen).toEqual(r.lines);
  });
});
