#!/usr/bin/env node
// One-time repair for stores written by reMem before 0.2.0.
//
// Consolidation reaches a model by launching Claude, and that nested session
// fired reMem's own hooks, so the ledger recorded reMem's consolidation prompts
// as things the user said. 0.2.0 marks those child processes and the hooks
// stand down for them, but rows already written are still there, and the ledger
// is append-only by design: nothing in normal operation can remove them.
//
// This is the privileged erasure path the design reserves for data that should
// never have been recorded, pointed at exactly that. It drops the append-only
// triggers, deletes rows whose content is one of reMem's own prompts, and puts
// the triggers back, inside one transaction.
//
//   node scripts/repair-self-observations.mjs            report only
//   node scripts/repair-self-observations.mjs --apply    remove them
//
// REMEM_DB is honoured, so it can be pointed at a copy first.

import { createRequire } from "node:module";
import { existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const apply = process.argv.includes("--apply");
// Rows the agent wrote about its own tool calls. reMem recorded these before
// the ledger was narrowed to the user's own words; they are evidence about the
// agent, not about the person, and nothing derives from them any more.
const includeAgent = !process.argv.includes("--keep-agent-rows");
const dbPath =
  process.env.REMEM_DB && process.env.REMEM_DB.trim() !== ""
    ? process.env.REMEM_DB
    : join(homedir(), ".remem", "remem.db");

if (!existsSync(dbPath)) {
  process.stdout.write(`No store at ${dbPath}. Nothing to repair.\n`);
  process.exit(0);
}

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const db = new Database(dbPath);

// The opening lines of reMem's own two prompts. Matched on the prefix rather
// than the whole text so a wording change between versions still matches, and
// anchored at the start so a user quoting one of these in conversation is not
// caught by it.
const SIGNATURES = [
  // reMem's own consolidation prompts, recorded when it launched Claude and
  // its own hooks caught the child session.
  "You maintain a user's long-term memory.%",
  "You write the record of a work session%",
  // Blocks the harness injects into the prompt channel. These arrive shaped
  // like a prompt and were recorded as the user's words.
  "<task-notification>%",
  "<system-reminder>%",
  "<local-command-stdout>%",
  "<local-command-stderr>%",
  "<command-name>%",
  "[cron:%",
  "<<autonomous-loop%",
];

const conditions = SIGNATURES.map((_, i) => `content LIKE @s${i}`);
if (includeAgent) conditions.push("actor != 'user'");

const rows = db
  .prepare(
    `SELECT id, ts, actor, substr(content, 1, 70) AS opening,
            json_extract(context_snapshot, '$.sessionId') AS session_id
       FROM observation
      WHERE ${conditions.join(" OR ")}
      ORDER BY ts`,
  )
  .all(Object.fromEntries(SIGNATURES.map((s, i) => [`s${i}`, s])));

if (rows.length === 0) {
  process.stdout.write(`Nothing to remove from ${dbPath}.\n`);
  process.exit(0);
}

process.stdout.write(
  `${rows.length} observation(s) in ${dbPath} are not the user's own words:\n`,
);
for (const row of rows.slice(0, 5)) {
  process.stdout.write(
    `  ${new Date(row.ts).toLocaleString()}  ${row.opening.replace(/\s+/g, " ")}...\n`,
  );
}
if (rows.length > 5)
  process.stdout.write(`  ... and ${rows.length - 5} more\n`);

if (!apply) {
  process.stdout.write(
    `\nNothing changed. Re-run with --apply to remove them.\n`,
  );
  process.exit(0);
}

const backup = `${dbPath}.before-repair-${Date.now()}`;
copyFileSync(dbPath, backup);
process.stdout.write(`\nBacked up to ${backup}\n`);

const ids = rows.map((r) => r.id);
const sessionIds = [...new Set(rows.map((r) => r.session_id).filter(Boolean))];

// What these observations were evidence for, recorded before they are removed:
// afterwards there is no way to tell which beliefs they supported.
const attachedBeliefs = db
  .prepare(
    `SELECT DISTINCT belief_id AS id FROM provenance
      WHERE observation_id IN (${ids.map((_, i) => `@i${i}`).join(",")})`,
  )
  .all(Object.fromEntries(ids.map((id, i) => [`i${i}`, id])))
  .map((r) => r.id);

const attachedEpisodes = db
  .prepare(
    `SELECT DISTINCT episode_id AS id FROM episode_provenance
      WHERE observation_id IN (${ids.map((_, i) => `@i${i}`).join(",")})`,
  )
  .all(Object.fromEntries(ids.map((id, i) => [`i${i}`, id])))
  .map((r) => r.id);

const beliefPlaceholders = attachedBeliefs.length
  ? attachedBeliefs.map((_, i) => `@b${i}`).join(",")
  : "NULL";
const beliefParams = Object.fromEntries(
  attachedBeliefs.map((id, i) => [`b${i}`, id]),
);
const episodePlaceholders = attachedEpisodes.length
  ? attachedEpisodes.map((_, i) => `@e${i}`).join(",")
  : "NULL";
const episodeParams = Object.fromEntries(
  attachedEpisodes.map((id, i) => [`e${i}`, id]),
);

const repair = db.transaction(() => {
  // The triggers exist to stop exactly this operation. Removing them for the
  // length of one transaction is the sanctioned exception, not a workaround:
  // they go back before anything else can run.
  db.exec(`DROP TRIGGER IF EXISTS observation_no_update`);
  db.exec(`DROP TRIGGER IF EXISTS observation_no_delete`);

  const placeholders = ids.map((_, i) => `@i${i}`).join(",");
  const params = Object.fromEntries(ids.map((id, i) => [`i${i}`, id]));

  // Anything derived from these rows goes with them: a belief resting only on
  // a prompt that was never said has nothing left to justify it.
  db.prepare(
    `DELETE FROM provenance WHERE observation_id IN (${placeholders})`,
  ).run(params);
  db.prepare(
    `DELETE FROM episode_provenance WHERE observation_id IN (${placeholders})`,
  ).run(params);
  db.prepare(`DELETE FROM observation WHERE id IN (${placeholders})`).run(
    params,
  );

  // Only beliefs that lost their last evidence to this deletion. A global
  // sweep would also take beliefs that never had provenance for unrelated
  // reasons, which this command has no business touching.
  const orphanedBeliefs = db
    .prepare(
      `SELECT id FROM belief
        WHERE id IN (${beliefPlaceholders})
          AND NOT EXISTS (
            SELECT 1 FROM provenance p WHERE p.belief_id = belief.id
          )`,
    )
    .all(beliefParams);
  for (const belief of orphanedBeliefs) {
    db.prepare(`DELETE FROM belief WHERE id = @id`).run({ id: belief.id });
  }

  const orphanedEpisodes = db
    .prepare(
      `SELECT id FROM episode
        WHERE id IN (${episodePlaceholders})
          AND NOT EXISTS (
            SELECT 1 FROM episode_provenance p WHERE p.episode_id = episode.id
          )`,
    )
    .all(episodeParams);
  for (const episode of orphanedEpisodes) {
    db.prepare(`DELETE FROM episode WHERE id = @id`).run({ id: episode.id });
  }

  // SQLite reuses the rowids of deleted rows, and consolidation resumes from a
  // rowid. Deleting from the tail of the ledger lowers max(rowid), so the next
  // observations written get numbers the watermark has already passed and are
  // never consolidated. Clearing it costs one pass over the ledger; leaving it
  // costs every belief that would have come after.
  db.prepare(`DELETE FROM kv WHERE key = 'consolidate:watermark'`).run();

  // Sessions that existed only to hold these prompts.
  for (const sessionId of sessionIds) {
    const remaining = db
      .prepare(
        `SELECT count(*) AS n FROM observation
          WHERE json_extract(context_snapshot, '$.sessionId') = @id`,
      )
      .get({ id: sessionId }).n;
    if (remaining === 0) {
      db.prepare(`DELETE FROM session WHERE id = @id`).run({ id: sessionId });
    }
  }

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS observation_no_update
    BEFORE UPDATE ON observation
    BEGIN
      SELECT RAISE(ABORT, 'observation is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS observation_no_delete
    BEFORE DELETE ON observation
    BEGIN
      SELECT RAISE(ABORT, 'observation is append-only');
    END;
  `);

  return { beliefs: orphanedBeliefs.length, episodes: orphanedEpisodes.length };
});

const removed = repair();

// The search index shadows what was just removed.
try {
  db.exec(`INSERT INTO observation_fts(observation_fts) VALUES('rebuild')`);
  db.exec(`INSERT INTO episode_fts(episode_fts) VALUES('rebuild')`);
} catch {
  // No FTS in this build. Search falls back to a scan, which reads the tables.
}

const check = db.prepare(`SELECT count(*) AS n FROM observation`).get().n;
db.close();

process.stdout.write(
  `Removed ${ids.length} observation(s), ` +
    `${removed.beliefs} unsupported belief(s), ` +
    `${removed.episodes} unsupported episode(s).\n` +
    `${check} observations remain.\n`,
);
