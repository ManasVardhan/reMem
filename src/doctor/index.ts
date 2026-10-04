// Why memory stopped working, in one screen.
//
// The failure mode that costs users is a silent one. Hooks are built never to
// break a session, so when the kernel cannot be resolved, or consolidation has
// no provider, they write one line to stderr that nobody reads and exit 0.
// Memory just stops: the ledger stops growing, or it grows and no belief ever
// forms. The first signal anyone gets is a person uninstalling. This turns
// those silences into something a person can read and act on.
//
// The diagnosis is pure. It takes a snapshot of the machine and returns
// findings, which keeps every rule here testable with no database, no network
// and no Claude Code install. Gathering the snapshot is the CLI's job.

export type Status = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  status: Status;
  detail: string;
  // What the user should run or do. Present whenever the status is not ok, so
  // a report is never a dead end.
  fix?: string;
}

export interface Snapshot {
  now: number;
  node: string;
  // The package the hooks would load, as they would resolve it. Absent means
  // the hooks cannot load reMem at all.
  kernel?: { root: string; version: string };
  // The plugin copy Claude Code actually runs. Claude Code copies the plugin
  // into its own cache, so this can lag the installed package.
  plugin?: { root: string; version: string };
  store: StoreSnapshot;
  embedder: { store: string; degraded?: string };
  // How consolidation would reach a model, if it can reach one at all.
  provider?: string;
  // The running viewer, and the store it serves. There is one claim file, so a
  // viewer started against a fixture takes it over; the hooks then decline the
  // warm path, which is correct and silent, and this is where that gets said.
  viewer?: { port: number; pid: number; alive: boolean; db?: string };
}

export interface StoreSnapshot {
  path: string;
  exists: boolean;
  writable: boolean;
  observations: number;
  beliefsActive: number;
  beliefsSuperseded: number;
  lastObservationTs?: number;
  // Observations the belief layer has not seen yet. Undefined when it cannot be
  // known: a session-scoped pass, which is what the plugin runs, deliberately
  // does not advance the watermark, so a store consolidated only by Claude Code
  // has no row to measure from. Silence beats a made-up number here, because
  // the obvious fallback of "everything" reads as a catastrophe on a healthy
  // machine.
  unconsolidated?: number;
}

const MS_PER_DAY = 86_400_000;

// A ledger that has not grown in this long, on a machine that has recorded
// before, means the observe hook is no longer running.
const SILENT_LEDGER_DAYS = 7;

// Consolidation runs at session end, so a backlog is normal and only means
// something once it is larger than a session or two. Past this, beliefs are
// meaningfully behind what the person has said.
const BACKLOG_OBSERVATIONS = 150;

const MIN_NODE_MAJOR = 20;

export function diagnose(s: Snapshot): Check[] {
  return [
    checkNode(s),
    checkKernel(s),
    checkVersions(s),
    checkStore(s),
    checkRecording(s),
    checkBeliefs(s),
    checkProvider(s),
    checkEmbedder(s),
    checkViewer(s),
  ].filter((c): c is Check => c !== undefined);
}

// The worst status present, which is what the exit code should reflect.
export function worst(checks: Check[]): Status {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "ok";
}

function checkNode(s: Snapshot): Check {
  const major = Number(/^v?(\d+)/.exec(s.node)?.[1] ?? 0);
  if (major >= MIN_NODE_MAJOR) {
    return { name: "node", status: "ok", detail: s.node };
  }
  return {
    name: "node",
    status: "fail",
    detail: `${s.node}, below the supported floor`,
    fix: `reMem needs Node ${MIN_NODE_MAJOR} or newer.`,
  };
}

function checkKernel(s: Snapshot): Check {
  if (!s.kernel) {
    return {
      name: "kernel",
      status: "fail",
      detail: "not found, so every hook is exiting without recording anything",
      fix: "npx remem-kernel setup",
    };
  }
  return {
    name: "kernel",
    status: "ok",
    detail: `${s.kernel.version} at ${s.kernel.root}`,
  };
}

// Claude Code keeps its own copy of the plugin, so upgrading the npm package
// leaves the hooks on the old version. That skew is invisible from inside a
// session and produces bugs that were fixed weeks ago.
function checkVersions(s: Snapshot): Check | undefined {
  if (!s.plugin) {
    return {
      name: "plugin",
      status: "warn",
      detail:
        "not installed in Claude Code, so nothing is recorded automatically",
      fix: "npx remem-kernel setup",
    };
  }
  if (!s.kernel) return undefined; // Already reported as a failure above.
  if (s.plugin.version === s.kernel.version) {
    return { name: "plugin", status: "ok", detail: s.plugin.version };
  }
  return {
    name: "plugin",
    status: "warn",
    detail: `plugin ${s.plugin.version} against kernel ${s.kernel.version}`,
    fix: "npx remem-kernel@latest setup   (brings the plugin and kernel to one version)",
  };
}

function checkStore(s: Snapshot): Check {
  const { store } = s;
  if (!store.exists) {
    return {
      name: "store",
      status: "warn",
      detail: `nothing at ${store.path} yet`,
      fix: "Start a Claude Code session, or run npx -p remem-kernel remem-import to bring history across.",
    };
  }
  if (!store.writable) {
    return {
      name: "store",
      status: "fail",
      detail: `${store.path} is not writable, so nothing can be recorded`,
      fix: `Check the permissions on ${store.path}.`,
    };
  }
  return {
    name: "store",
    status: "ok",
    detail:
      `${store.observations} observations, ` +
      `${store.beliefsActive} active beliefs, ` +
      `${store.beliefsSuperseded} superseded`,
  };
}

function checkRecording(s: Snapshot): Check | undefined {
  const { store } = s;
  if (!store.exists) return undefined;

  if (store.observations === 0) {
    return {
      name: "recording",
      status: "warn",
      detail: "no observations recorded",
      fix: "Start a Claude Code session and say something, then run this again.",
    };
  }

  const last = store.lastObservationTs;
  if (last === undefined) return undefined;

  const days = Math.floor((s.now - last) / MS_PER_DAY);
  if (days >= SILENT_LEDGER_DAYS) {
    return {
      name: "recording",
      status: "warn",
      detail: `nothing recorded in ${days} days, so the observe hook may not be running`,
      fix: "npx remem-kernel doctor after restarting Claude Code, or re-run npx remem-kernel setup.",
    };
  }
  return {
    name: "recording",
    status: "ok",
    detail: `last observation ${ago(days)}`,
  };
}

// The symptom users actually report: memory remembers nothing useful. Almost
// always the ledger is fine and consolidation never ran, because a session
// ended without a model provider.
function checkBeliefs(s: Snapshot): Check | undefined {
  const { store } = s;
  if (!store.exists || store.observations === 0) return undefined;

  if (store.beliefsActive === 0) {
    return {
      name: "beliefs",
      status: "fail",
      detail: `${store.observations} observations and no beliefs, so consolidation has never run`,
      fix: "npx -p remem-kernel remem-consolidate --all",
    };
  }
  if (store.unconsolidated === undefined) {
    return {
      name: "beliefs",
      status: "ok",
      detail: `${store.beliefsActive} active`,
    };
  }
  if (store.unconsolidated >= BACKLOG_OBSERVATIONS) {
    return {
      name: "beliefs",
      status: "warn",
      detail: `${store.unconsolidated} observations the belief layer has not seen`,
      fix: "npx -p remem-kernel remem-consolidate",
    };
  }
  return {
    name: "beliefs",
    status: "ok",
    detail:
      store.unconsolidated === 0
        ? "up to date with the ledger"
        : `${store.unconsolidated} observations pending, which the next session end will take`,
  };
}

function checkProvider(s: Snapshot): Check {
  if (s.provider) {
    return { name: "consolidation", status: "ok", detail: `via ${s.provider}` };
  }
  return {
    name: "consolidation",
    status: "warn",
    detail: "no model provider, so beliefs cannot form",
    fix: "Run inside Claude Code, or set ANTHROPIC_API_KEY or OPENAI_API_KEY.",
  };
}

// Recall compares vectors. A store written by one embedder and read by another
// does not error, it silently returns noise that looks like an answer, so a
// mismatch matters more than it sounds.
function checkEmbedder(s: Snapshot): Check {
  if (s.embedder.degraded) {
    return {
      name: "embedder",
      status: "fail",
      detail: `${s.embedder.store} could not be loaded, so recall is returning noise: ${s.embedder.degraded}`,
      fix: "Reinstall remem-kernel, or run remem-reembed to move the store to an embedder that loads.",
    };
  }
  return { name: "embedder", status: "ok", detail: s.embedder.store };
}

function checkViewer(s: Snapshot): Check | undefined {
  if (!s.viewer) return undefined;
  if (!s.viewer.alive) {
    return {
      name: "viewer",
      status: "warn",
      detail: `claims port ${s.viewer.port} but that process is gone, so hooks will fall back to loading a model each time`,
      fix: "npx -p remem-kernel remem-viewer",
    };
  }
  if (s.viewer.db !== undefined && s.viewer.db !== s.store.path) {
    return {
      name: "viewer",
      status: "warn",
      detail: `serving ${s.viewer.db}, not this store, so hooks are loading their own model instead`,
      fix: "Stop that viewer, or start one without REMEM_DB set.",
    };
  }
  return {
    name: "viewer",
    status: "ok",
    detail: `http://localhost:${s.viewer.port}`,
  };
}

function ago(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}
