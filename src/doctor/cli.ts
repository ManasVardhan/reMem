#!/usr/bin/env node
// remem-doctor: is memory actually working?
//
// Hooks are deliberately silent when they fail, because a memory system that
// breaks someone's session is worse than one that misses an observation. The
// cost of that choice is that a broken install looks exactly like a working
// one until someone notices reMem has not learned anything in a fortnight.
// This is where that silence gets read out loud.
//
// Gathering the facts lives here; judging them lives in ./index.ts, which is
// pure so the rules can be tested without a machine to break.

import { existsSync, readFileSync, accessSync, readdirSync } from "node:fs";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { openDb, type DB } from "../db/client.js";
import { dbPath } from "../mcp/store.js";
import { getWatermark } from "../consolidate/index.js";
import { storeIdentity, selectEmbedder } from "../embed/select.js";
import { selectCompleter } from "../consolidate/select.js";
import {
  diagnose,
  worst,
  type Check,
  type Snapshot,
  type StoreSnapshot,
} from "./index.js";

const HELP = `remem-doctor: check that memory is actually working

  remem-doctor           the usual checks, fast
  remem-doctor --deep    also load the store's embedder, which proves recall works
  remem-doctor --json    machine-readable findings

Exits non-zero when something is broken, so it can gate a script.
`;

// Where a hook caches the kernel it resolved. Reading the same file the hooks
// read is the point: this reports what they would find, not what this process
// happens to be running from.
const KERNEL_CACHE = join(homedir(), ".remem", "kernel-path.json");
const VIEWER_STATE = join(homedir(), ".remem", "viewer.json");

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function versionAt(root: string): string | undefined {
  const pkg = readJson(join(root, "package.json"));
  const version = (pkg as { version?: unknown } | undefined)?.version;
  return typeof version === "string" ? version : undefined;
}

// The package the hooks would load. Their cache first, since that is the answer
// they will actually use, then the copy this process is running from.
function findKernel(): { root: string; version: string } | undefined {
  const cached = readJson(KERNEL_CACHE) as { root?: string } | undefined;
  const own = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  for (const root of [cached?.root, own]) {
    if (!root || !existsSync(join(root, "dist", "index.js"))) continue;
    const version = versionAt(root);
    if (version) return { root, version };
  }
  return undefined;
}

// Claude Code copies the plugin into its own cache under
// plugins/cache/<marketplace>/<plugin>/<version>/, so the version is a
// directory name and the newest one is the copy in use.
function findPlugin(): { root: string; version: string } | undefined {
  const config = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const cache = join(config, "plugins", "cache");
  if (!existsSync(cache)) return undefined;

  const found: { root: string; version: string }[] = [];
  for (const marketplace of safeReaddir(cache)) {
    for (const plugin of safeReaddir(join(cache, marketplace))) {
      if (plugin !== "remem") continue;
      for (const version of safeReaddir(join(cache, marketplace, plugin))) {
        const root = join(cache, marketplace, plugin, version);
        if (existsSync(join(root, "hooks", "hooks.json"))) {
          found.push({ root, version });
        }
      }
    }
  }
  return found.sort((a, b) => compareVersions(b.version, a.version))[0];
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function count(db: DB, sql: string): number {
  const row = db.prepare(sql).get() as { n?: number } | undefined;
  return typeof row?.n === "number" ? row.n : 0;
}

function readStore(path: string): { store: StoreSnapshot; db?: DB } {
  const empty: StoreSnapshot = {
    path,
    exists: false,
    writable: false,
    observations: 0,
    beliefsActive: 0,
    beliefsSuperseded: 0,
    unconsolidated: 0,
  };
  if (!existsSync(path)) return { store: empty };

  try {
    const db = openDb({ path, readonly: true });
    const watermark = getWatermark(db);
    const lastTs = (
      db.prepare(`SELECT MAX(ts) AS n FROM observation`).get() as {
        n?: number | null;
      }
    ).n;
    const store: StoreSnapshot = {
      path,
      exists: true,
      writable: writable(path),
      observations: count(db, `SELECT COUNT(*) AS n FROM observation`),
      beliefsActive: count(
        db,
        `SELECT COUNT(*) AS n FROM belief WHERE status = 'active'`,
      ),
      beliefsSuperseded: count(
        db,
        `SELECT COUNT(*) AS n FROM belief WHERE status = 'superseded'`,
      ),
      ...backlog(db, watermark?.rowid),
      ...(typeof lastTs === "number" ? { lastObservationTs: lastTs } : {}),
    };
    return { store, db };
  } catch {
    // A file that exists but cannot be read as a store is worse than none, and
    // the store check will say so.
    return { store: { ...empty, exists: true, writable: writable(path) } };
  }
}

// How far the belief layer trails the ledger.
//
// An incremental pass leaves a watermark, which is exact. The plugin's
// session-scoped pass leaves none, so fall back to the last time any belief was
// touched: on a machine where consolidation runs at session end, that is the
// end of the previous session, and anything after it is genuinely pending.
// With no beliefs at all there is nothing to measure from, and the rule that
// catches that case is a different one.
function backlog(
  db: DB,
  rowid: number | undefined,
): { unconsolidated?: number } {
  if (rowid !== undefined) {
    return {
      unconsolidated: count(
        db,
        `SELECT COUNT(*) AS n FROM observation WHERE rowid > ${Number(rowid)}`,
      ),
    };
  }
  const last = (
    db
      .prepare(
        `SELECT MAX(MAX(created_ts), MAX(last_reinforced_ts)) AS n FROM belief`,
      )
      .get() as { n?: number | null }
  ).n;
  if (typeof last !== "number") return {};
  return {
    unconsolidated: count(
      db,
      `SELECT COUNT(*) AS n FROM observation WHERE ts > ${Number(last)}`,
    ),
  };
}

function readViewer(): Snapshot["viewer"] {
  const state = readJson(VIEWER_STATE) as
    | { port?: number; pid?: number; db?: string }
    | undefined;
  if (typeof state?.port !== "number" || typeof state.pid !== "number") {
    return undefined;
  }
  const db = typeof state.db === "string" ? state.db : undefined;
  let alive = false;
  try {
    // Signal 0 tests for the process without touching it.
    process.kill(state.pid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  return { port: state.port, pid: state.pid, alive, ...(db ? { db } : {}) };
}

async function embedderFacts(
  db: DB | undefined,
  deep: boolean,
): Promise<Snapshot["embedder"]> {
  if (!db) return { store: "unknown, no store to read it from" };
  const identity = storeIdentity(db);
  const name =
    identity.model !== undefined
      ? `${identity.name}:${identity.model}`
      : identity.name;

  if (identity.name !== "transformers") return { store: name };

  if (deep) {
    // The honest check: build the thing and see. Slow, and the first run on a
    // machine may download a model, which is why it is not the default.
    const selected = await selectEmbedder(db);
    return selected.degraded
      ? { store: name, degraded: selected.degraded }
      : { store: name };
  }

  // The cheap check: the module the store needs has to at least resolve.
  try {
    createRequire(import.meta.url).resolve("@huggingface/transformers");
    return { store: name };
  } catch {
    return {
      store: name,
      degraded: "@huggingface/transformers is not installed",
    };
  }
}

function render(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  let out = "";
  for (const check of checks) {
    out += `  ${check.status.padEnd(4)}  ${check.name.padEnd(width)}  ${check.detail}\n`;
    if (check.fix)
      out += `  ${" ".repeat(4)}  ${" ".repeat(width)}  -> ${check.fix}\n`;
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  const deep = argv.includes("--deep");
  const asJson = argv.includes("--json");

  const { store, db } = readStore(dbPath());
  const provider = (await selectCompleter()).source;
  const kernel = findKernel();
  const plugin = findPlugin();
  const viewer = readViewer();

  const snapshot: Snapshot = {
    now: Date.now(),
    node: process.version,
    store,
    embedder: await embedderFacts(db, deep),
    ...(kernel ? { kernel } : {}),
    ...(plugin ? { plugin } : {}),
    ...(provider !== "none" ? { provider } : {}),
    ...(viewer ? { viewer } : {}),
  };
  db?.close();

  const checks = diagnose(snapshot);
  const status = worst(checks);

  if (asJson) {
    // kernel and plugin let setup tell version skew apart from other warnings
    // without parsing the human-readable detail.
    const json = {
      status,
      checks,
      ...(kernel ? { kernel } : {}),
      ...(plugin ? { plugin: { version: plugin.version } } : {}),
    };
    process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
  } else {
    process.stdout.write(`\nreMem ${snapshot.kernel?.version ?? ""}\n\n`);
    process.stdout.write(render(checks));
    process.stdout.write(
      status === "ok"
        ? "\nMemory is working.\n"
        : status === "warn"
          ? "\nMemory is working, with the caveats above.\n"
          : "\nMemory is not working. Start with the first failure above.\n",
    );
  }

  if (status === "fail") process.exitCode = 1;
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`reMem doctor failed: ${message}\n`);
  process.exitCode = 1;
});
