import { describe, expect, it } from "vitest";
import { planSetup, normalizeSource, type Probe } from "./plan.js";

const opts = { source: "ManasVardhan/reMem", version: "0.3.0" };
const fresh: Probe = {
  node: "v22.3.0",
  claude: true,
  npm: true,
  pluginInstalled: false,
};
const cmds = (steps: ReturnType<typeof planSetup>) =>
  steps
    .filter((s) => s.kind === "run")
    .map((s) => (s.kind === "run" ? [s.cmd, ...s.args].join(" ") : ""));

describe("normalizeSource", () => {
  it("treats owner/repo as GitHub", () => {
    expect(normalizeSource("ManasVardhan/reMem")).toBe(
      "github:ManasVardhan/reMem",
    );
  });
  it("treats a path as a directory", () => {
    expect(normalizeSource("/tmp/remem-export")).toBe(
      "directory:/tmp/remem-export",
    );
  });
});

describe("planSetup", () => {
  it("fails first on old node, with nothing else planned", () => {
    const steps = planSetup({ ...fresh, node: "v18.19.0" }, opts);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "fail" });
  });
  it("fails when claude is missing", () => {
    const steps = planSetup({ ...fresh, claude: false }, opts);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "fail" });
    if (steps[0]?.kind === "fail") expect(steps[0].fix).toContain("claude");
  });
  it("fails when npm is missing", () => {
    const steps = planSetup({ ...fresh, npm: false }, opts);
    expect(steps[0]).toMatchObject({ kind: "fail" });
  });
  it("installs everything on a fresh machine", () => {
    expect(cmds(planSetup(fresh, opts))).toEqual([
      "claude plugin marketplace add ManasVardhan/reMem",
      "claude plugin install remem@remem",
      `npm install --prefix ${"<RUNTIME>"} --no-audit --no-fund remem-kernel@0.3.0`,
    ]);
  });
  it("refreshes and updates when already installed from the same source", () => {
    const p: Probe = {
      ...fresh,
      marketplaceSource: "github:ManasVardhan/reMem",
      pluginInstalled: true,
      runtimeKernelVersion: "0.3.0",
    };
    expect(cmds(planSetup(p, opts))).toEqual([
      "claude plugin marketplace update remem",
      "claude plugin update remem@remem",
    ]);
  });
  it("replaces a marketplace registered from another source and reinstalls the plugin", () => {
    const p: Probe = {
      ...fresh,
      marketplaceSource:
        "directory:/opt/homebrew/lib/node_modules/remem-kernel",
      pluginInstalled: true,
      runtimeKernelVersion: "0.2.2",
    };
    expect(cmds(planSetup(p, opts))).toEqual([
      "claude plugin uninstall remem@remem",
      "claude plugin marketplace remove remem",
      "claude plugin marketplace add ManasVardhan/reMem",
      "claude plugin install remem@remem",
      `npm install --prefix <RUNTIME> --no-audit --no-fund remem-kernel@0.3.0`,
    ]);
  });
  it("installs the plugin when the marketplace exists but the plugin does not", () => {
    const p: Probe = {
      ...fresh,
      marketplaceSource: "github:ManasVardhan/reMem",
      runtimeKernelVersion: "0.3.0",
    };
    expect(cmds(planSetup(p, opts))).toEqual([
      "claude plugin marketplace update remem",
      "claude plugin install remem@remem",
    ]);
  });
  it("always ends with pin-kernel, doctor, then done", () => {
    const steps = planSetup(fresh, opts);
    expect(steps.at(-3)).toEqual({ kind: "pin-kernel" });
    expect(steps.at(-2)).toEqual({ kind: "doctor" });
    expect(steps.at(-1)).toMatchObject({ kind: "done" });
  });
  it("pins the runtime kernel even when it is already current", () => {
    const p: Probe = {
      ...fresh,
      marketplaceSource: "github:ManasVardhan/reMem",
      pluginInstalled: true,
      runtimeKernelVersion: "0.3.0",
    };
    const kinds = planSetup(p, opts).map((s) => s.kind);
    expect(kinds).toContain("pin-kernel");
    expect(kinds.indexOf("pin-kernel")).toBeLessThan(kinds.indexOf("doctor"));
  });
  it("pins the kernel only after the npm step that fetches it", () => {
    const steps = planSetup(fresh, opts);
    const npm = steps.findIndex((s) => s.kind === "run" && s.cmd === "npm");
    const pin = steps.findIndex((s) => s.kind === "pin-kernel");
    expect(npm).toBeGreaterThan(-1);
    expect(pin).toBe(npm + 1);
  });
});
