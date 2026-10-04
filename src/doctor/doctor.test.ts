import { describe, it, expect } from "vitest";
import { diagnose, worst, type Snapshot } from "./index.js";

const NOW = Date.UTC(2026, 8, 22);
const MS_PER_DAY = 86_400_000;

// A machine where everything works. Each test breaks exactly one thing, so a
// failing assertion names the rule that moved.
function healthy(): Snapshot {
  return {
    now: NOW,
    node: "v22.3.0",
    kernel: {
      root: "/usr/local/lib/node_modules/remem-kernel",
      version: "0.2.1",
    },
    plugin: {
      root: "/home/u/.claude/plugins/cache/remem/remem/0.2.1",
      version: "0.2.1",
    },
    store: {
      path: "/home/u/.remem/remem.db",
      exists: true,
      writable: true,
      observations: 1446,
      beliefsActive: 56,
      beliefsSuperseded: 12,
      lastObservationTs: NOW - MS_PER_DAY,
      unconsolidated: 4,
    },
    embedder: { store: "transformers:all-MiniLM-L6-v2" },
    provider: "claude-cli",
    viewer: { port: 37800, pid: 4242, alive: true },
  };
}

function find(s: Snapshot, name: string) {
  return diagnose(s).find((c) => c.name === name);
}

describe("doctor", () => {
  it("reports a healthy machine as entirely ok", () => {
    const checks = diagnose(healthy());
    expect(worst(checks)).toBe("ok");
    expect(checks.every((c) => c.fix === undefined)).toBe(true);
  });

  it("fails when the kernel cannot be found, because hooks then record nothing", () => {
    const s = healthy();
    delete s.kernel;
    const check = find(s, "kernel");
    expect(check?.status).toBe("fail");
    expect(check?.fix).toBe("npx remem-kernel setup");
  });

  it("does not also complain about the plugin when the kernel is missing", () => {
    // One cause, one finding. A missing kernel already explains the silence,
    // and a second line about version skew would only crowd it out.
    const s = healthy();
    delete s.kernel;
    expect(find(s, "plugin")).toBeUndefined();
  });

  it("warns when Claude Code runs an older copy of the plugin than the kernel", () => {
    const s = healthy();
    s.kernel = { ...s.kernel!, version: "0.3.0" };
    const check = find(s, "plugin");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("0.2.1");
    expect(check?.detail).toContain("0.3.0");
  });

  it("warns when the plugin is not installed at all", () => {
    const s = healthy();
    delete s.plugin;
    expect(find(s, "plugin")?.status).toBe("warn");
  });

  it("fails when the store cannot be written to", () => {
    const s = healthy();
    s.store.writable = false;
    expect(find(s, "store")?.status).toBe("fail");
  });

  it("warns when the ledger has not grown in a week, which means the hook stopped", () => {
    const s = healthy();
    s.store.lastObservationTs = NOW - 9 * MS_PER_DAY;
    const check = find(s, "recording");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("9 days");
  });

  it("treats a ledger that grew yesterday as fine", () => {
    expect(find(healthy(), "recording")?.status).toBe("ok");
  });

  it("fails when observations exist but no belief was ever formed", () => {
    // The loudest symptom of a broken install: the ledger fills up and recall
    // still knows nothing, because consolidation never ran.
    const s = healthy();
    s.store.beliefsActive = 0;
    const check = find(s, "beliefs");
    expect(check?.status).toBe("fail");
    expect(check?.fix).toContain("--all");
  });

  it("warns once the belief layer falls far behind the ledger", () => {
    const s = healthy();
    s.store.unconsolidated = 400;
    expect(find(s, "beliefs")?.status).toBe("warn");
  });

  it("accepts a small backlog, which is just a session that has not ended", () => {
    const s = healthy();
    s.store.unconsolidated = 20;
    expect(find(s, "beliefs")?.status).toBe("ok");
  });

  it("stays calm when the backlog cannot be measured at all", () => {
    // A store consolidated only by the plugin has no watermark. Reporting the
    // whole ledger as pending would scream on a perfectly healthy machine.
    const s = healthy();
    delete s.store.unconsolidated;
    const check = find(s, "beliefs");
    expect(check?.status).toBe("ok");
    expect(check?.detail).toBe("56 active");
  });

  it("stays quiet about beliefs on a store with nothing in it yet", () => {
    const s = healthy();
    s.store.observations = 0;
    expect(find(s, "beliefs")).toBeUndefined();
    expect(find(s, "recording")?.status).toBe("warn");
  });

  it("warns when no model provider is reachable", () => {
    const s = healthy();
    delete s.provider;
    expect(find(s, "consolidation")?.status).toBe("warn");
  });

  it("fails when the store's embedder will not load, because recall then returns noise", () => {
    const s = healthy();
    s.embedder = {
      store: "transformers:all-MiniLM-L6-v2",
      degraded: "module not found",
    };
    expect(find(s, "embedder")?.status).toBe("fail");
  });

  it("warns when the running viewer is serving a different store", () => {
    // A viewer started on a fixture takes over the one claim file. The hooks
    // then decline the warm path, correctly and without a word, which looks
    // from the outside like recall simply got slow.
    const s = healthy();
    s.viewer = {
      port: 37877,
      pid: 4242,
      alive: true,
      db: "/home/u/reMem/fixtures/demo.db",
    };
    const check = find(s, "viewer");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("demo.db");
  });

  it("accepts a viewer serving this very store", () => {
    const s = healthy();
    s.viewer = { port: 37800, pid: 4242, alive: true, db: s.store.path };
    expect(find(s, "viewer")?.status).toBe("ok");
  });

  it("warns when the viewer left a claim behind after dying", () => {
    const s = healthy();
    s.viewer = { port: 37800, pid: 4242, alive: false };
    expect(find(s, "viewer")?.status).toBe("warn");
  });

  it("fails on a Node older than the supported floor", () => {
    const s = healthy();
    s.node = "v18.20.0";
    expect(find(s, "node")?.status).toBe("fail");
  });

  it("gives every non-ok finding something to do about it", () => {
    const s = healthy();
    delete s.kernel;
    delete s.provider;
    s.store.beliefsActive = 0;
    for (const check of diagnose(s)) {
      if (check.status !== "ok") expect(check.fix, check.name).toBeTruthy();
    }
  });

  it("reports the worst status present", () => {
    expect(worst([{ name: "a", status: "ok", detail: "" }])).toBe("ok");
    expect(
      worst([
        { name: "a", status: "ok", detail: "" },
        { name: "b", status: "warn", detail: "" },
      ]),
    ).toBe("warn");
    expect(
      worst([
        { name: "a", status: "warn", detail: "" },
        { name: "b", status: "fail", detail: "" },
      ]),
    ).toBe("fail");
  });
});
