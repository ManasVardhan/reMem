// Episodes: the derived, structured account of what happened.
//
// An observation is what was said, verbatim and forever. An episode is what a
// stretch of observations amounted to: a title, what was learned, which files
// moved. It is derived, so it may be rewritten or dropped and rebuilt, and like
// a belief it must resolve to the observations that justify it. An episode with
// no provenance is not stored.

import { randomUUID } from "node:crypto";
import type { DB } from "../db/client.js";
import { toJson, fromJson } from "../db/serde.js";
import type { EpisodeKind, EpisodeRecord } from "../types/index.js";

interface EpisodeRow {
  id: string;
  session_id: string | null;
  project: string | null;
  ts: number;
  kind: string;
  title: string;
  subtitle: string | null;
  narrative: string | null;
  facts: string;
  concepts: string;
  files_read: string;
  files_changed: string;
  meta: string;
}

function rowToRecord(row: EpisodeRow): EpisodeRecord {
  return {
    id: row.id,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.project ? { project: row.project } : {}),
    ts: row.ts,
    kind: row.kind as EpisodeKind,
    title: row.title,
    ...(row.subtitle ? { subtitle: row.subtitle } : {}),
    ...(row.narrative ? { narrative: row.narrative } : {}),
    facts: fromJson<string[]>(row.facts, []),
    concepts: fromJson<string[]>(row.concepts, []),
    filesRead: fromJson<string[]>(row.files_read, []),
    filesChanged: fromJson<string[]>(row.files_changed, []),
    meta: fromJson<Record<string, unknown>>(row.meta, {}),
  };
}

export interface EpisodeInput {
  id?: string;
  sessionId?: string;
  project?: string;
  ts?: number;
  kind?: EpisodeKind;
  title: string;
  subtitle?: string;
  narrative?: string;
  facts?: string[];
  concepts?: string[];
  filesRead?: string[];
  filesChanged?: string[];
  meta?: Record<string, unknown>;
  // The observations this account is drawn from. Required in spirit: an
  // episode that cannot point at the ledger is a story we made up.
  observationIds?: string[];
}

export function putEpisode(db: DB, input: EpisodeInput): EpisodeRecord {
  const id = input.id ?? randomUUID();
  const ts = input.ts ?? Date.now();

  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO episode
         (id, session_id, project, ts, kind, title, subtitle, narrative,
          facts, concepts, files_read, files_changed, meta)
       VALUES
         (@id, @session_id, @project, @ts, @kind, @title, @subtitle, @narrative,
          @facts, @concepts, @files_read, @files_changed, @meta)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind, title = excluded.title,
         subtitle = excluded.subtitle, narrative = excluded.narrative,
         facts = excluded.facts, concepts = excluded.concepts,
         files_read = excluded.files_read, files_changed = excluded.files_changed,
         meta = excluded.meta`,
    ).run({
      id,
      session_id: input.sessionId ?? null,
      project: input.project ?? null,
      ts,
      kind: input.kind ?? "discovery",
      title: input.title,
      subtitle: input.subtitle ?? null,
      narrative: input.narrative ?? null,
      facts: toJson(input.facts ?? []),
      concepts: toJson(input.concepts ?? []),
      files_read: toJson(input.filesRead ?? []),
      files_changed: toJson(input.filesChanged ?? []),
      meta: toJson(input.meta ?? {}),
    });

    const link = db.prepare(
      `INSERT OR IGNORE INTO episode_provenance (episode_id, observation_id)
       VALUES (@episode_id, @observation_id)`,
    );
    for (const observationId of input.observationIds ?? []) {
      link.run({ episode_id: id, observation_id: observationId });
    }
  });
  write();

  return getEpisode(db, id) as EpisodeRecord;
}

export function getEpisode(db: DB, id: string): EpisodeRecord | undefined {
  const row = db.prepare(`SELECT * FROM episode WHERE id = @id`).get({ id }) as
    | EpisodeRow
    | undefined;
  return row ? rowToRecord(row) : undefined;
}

export function getEpisodeObservationIds(db: DB, episodeId: string): string[] {
  const rows = db
    .prepare(
      `SELECT observation_id FROM episode_provenance WHERE episode_id = @id`,
    )
    .all({ id: episodeId }) as Array<{ observation_id: string }>;
  return rows.map((r) => r.observation_id);
}

export interface EpisodeQuery {
  project?: string;
  sessionId?: string;
  kind?: string;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
  // Resume after an exact row in this list's own (ts desc, id desc) order.
  // A timestamp alone cannot express it: episodes share timestamps, and a
  // page boundary landing inside a tie either repeats rows or strands them.
  before?: { ts: number; id: string };
}

// Newest first: an episode list is something a person reads back, and the last
// thing that happened is the thing they are looking for.
export function listEpisodes(
  db: DB,
  query: EpisodeQuery = {},
): EpisodeRecord[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {
    limit: query.limit ?? 100,
    offset: query.offset ?? 0,
  };
  if (query.project !== undefined) {
    clauses.push("project = @project");
    params.project = query.project;
  }
  if (query.sessionId !== undefined) {
    clauses.push("session_id = @session_id");
    params.session_id = query.sessionId;
  }
  if (query.kind !== undefined) {
    clauses.push("kind = @kind");
    params.kind = query.kind;
  }
  if (query.since !== undefined) {
    clauses.push("ts >= @since");
    params.since = query.since;
  }
  if (query.until !== undefined) {
    clauses.push("ts <= @until");
    params.until = query.until;
  }
  if (query.before !== undefined) {
    clauses.push("(ts < @beforeTs OR (ts = @beforeTs AND id < @beforeId))");
    params.beforeTs = query.before.ts;
    params.beforeId = query.before.id;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT * FROM episode ${where}
        ORDER BY ts DESC, id DESC LIMIT @limit OFFSET @offset`,
    )
    .all(params) as EpisodeRow[];
  return rows.map(rowToRecord);
}

export function countEpisodes(db: DB, project?: string): number {
  const row = (
    project
      ? db
          .prepare(`SELECT count(*) AS n FROM episode WHERE project = @project`)
          .get({ project })
      : db.prepare(`SELECT count(*) AS n FROM episode`).get()
  ) as { n: number };
  return row.n;
}
