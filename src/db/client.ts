import Database from "better-sqlite3";
import { SCHEMA_SQL, FTS_SQL } from "./schema.js";

export type DB = Database.Database;

export interface OpenOptions {
  // File path, or ":memory:" for an ephemeral database (used in tests).
  path?: string;
  readonly?: boolean;
}

// Opens the database, applies pragmatic defaults, and ensures the schema exists.
// better-sqlite3 is a concrete SQLite driver; the design targets libSQL/SQLite,
// and this thin wrapper is the single place a libSQL/Turso client would be
// swapped in later without touching callers.
export function openDb(opts: OpenOptions = {}): DB {
  const db = new Database(opts.path ?? ":memory:", {
    readonly: opts.readonly ?? false,
  });
  db.pragma("foreign_keys = ON");

  // A readonly connection cannot create anything, and a store that predates a
  // schema addition would fail to open at all if we tried. Readers take the
  // database as they find it; the next writer migrates it.
  if (opts.readonly) return db;

  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  ensureFts(db);
  return db;
}

// Full-text search is an optimisation, not a guarantee: a SQLite without FTS5
// still gets a working store, and search falls back to a scan. Kept separate
// from openDb's contract for exactly that reason.
export function ensureFts(db: DB): boolean {
  try {
    db.exec(FTS_SQL);
    return true;
  } catch {
    return false;
  }
}

export function hasFts(db: DB): boolean {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM sqlite_master
        WHERE type = 'table' AND name IN ('observation_fts', 'episode_fts')`,
    )
    .get() as { n: number };
  return row.n === 2;
}

// The FTS indexes shadow tables that can be written by a connection that never
// built them (an older reMem, or a bulk import inside a transaction). Rebuild
// when the shadow has fallen behind rather than trusting the triggers alone.
export function syncFts(db: DB): void {
  if (!hasFts(db)) return;
  const pairs: Array<[string, string]> = [
    ["observation", "observation_fts"],
    ["episode", "episode_fts"],
  ];
  for (const [table, index] of pairs) {
    const live = (
      db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }
    ).n;
    const shadow = (
      db.prepare(`SELECT count(*) AS n FROM ${index}`).get() as { n: number }
    ).n;
    if (live !== shadow) {
      db.exec(`INSERT INTO ${index}(${index}) VALUES('rebuild')`);
    }
  }
}
