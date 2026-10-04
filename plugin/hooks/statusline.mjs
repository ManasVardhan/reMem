#!/usr/bin/env node
// Statusline: what memory holds for the project you are standing in.
//
// Runs on every statusline refresh, so it must be cheap and must never fail
// loudly. A direct readonly SQLite read, no server, no model, and a zeroed
// answer whenever anything is missing.
//
// Usage:
//   node statusline.mjs [cwd]          human line, for statusLine.command
//   node statusline.mjs [cwd] --json   {"said":N,"happened":N,"believed":N}

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { createRequire } from "node:module";
import { kernelRoot } from "./_shared.mjs";

const args = process.argv.slice(2).filter((a) => a !== "--json");
const asJson = process.argv.includes("--json");
const cwd = args[0] || process.env.CLAUDE_CWD || process.cwd();
const project = basename(cwd);

const empty = { said: 0, happened: 0, believed: 0, project };

function emit(counts) {
  if (asJson) {
    process.stdout.write(JSON.stringify(counts) + "\n");
    return;
  }
  // Nothing to say is better than a row of zeros in someone's status bar.
  if (!counts.said && !counts.believed) {
    process.stdout.write("\n");
    return;
  }
  const parts = [];
  if (counts.believed) parts.push(`${counts.believed} believed`);
  if (counts.said) parts.push(`${counts.said} said`);
  if (counts.happened) parts.push(`${counts.happened} done`);
  process.stdout.write(`remem ${parts.join(", ")}\n`);
}

try {
  const dbPath =
    process.env.REMEM_DB && process.env.REMEM_DB.trim() !== ""
      ? process.env.REMEM_DB
      : join(homedir(), ".remem", "remem.db");

  if (!existsSync(dbPath)) {
    emit(empty);
    process.exit(0);
  }

  // The driver has to be resolved from the installed package, not from here:
  // this file runs out of Claude Code's plugin cache, which has no node_modules
  // above it, so a bare require finds nothing and the status bar silently shows
  // zeros. Same resolution problem the hooks have, same answer.
  const root = kernelRoot();
  if (!root) {
    emit(empty);
    process.exit(0);
  }

  const require = createRequire(join(root, "package.json"));
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch {
    emit(empty);
    process.exit(0);
  }

  const db = new Database(dbPath, { readonly: true });
  const one = (sql, params = {}) => {
    try {
      return db.prepare(sql).get(params)?.n ?? 0;
    } catch {
      return 0;
    }
  };

  const counts = {
    said: one(
      `SELECT count(*) AS n FROM observation
        WHERE actor = 'user'
          AND json_extract(context_snapshot, '$.projectName') = @project`,
      { project },
    ),
    happened: one(
      `SELECT count(*) AS n FROM episode WHERE project = @project`,
      {
        project,
      },
    ),
    // Scoped like the others. A global count next to a project-scoped one read
    // as "memory holds 214 things about this project" in a directory it had
    // never seen. Beliefs with no project hold everywhere, so they count here.
    believed: one(
      `SELECT count(*) AS n FROM belief
        WHERE status = 'active'
          AND (json_extract(scope, '$.project') IS NULL
               OR json_extract(scope, '$.project') = @project)`,
      { project },
    ),
    project,
  };
  db.close();
  emit(counts);
} catch {
  emit(empty);
}
