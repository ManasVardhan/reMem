// Session bookkeeping: which observations arrived together, in what project,
// and whether the session is still running.
//
// A session owns no truth. Delete every row here and the ledger is unchanged;
// what is lost is only the ability to say "these arrived together".

import type { DB } from "../db/client.js";
import { toJson, fromJson } from "../db/serde.js";
import type { SessionRecord, SessionStatus } from "../types/index.js";

interface SessionRow {
  id: string;
  source: string;
  project: string | null;
  project_name: string | null;
  title: string | null;
  started_ts: number;
  ended_ts: number | null;
  status: string;
  prompt_count: number;
  meta: string;
}

function rowToRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    source: row.source,
    ...(row.project ? { project: row.project } : {}),
    ...(row.project_name ? { projectName: row.project_name } : {}),
    ...(row.title ? { title: row.title } : {}),
    startedTs: row.started_ts,
    ...(row.ended_ts ? { endedTs: row.ended_ts } : {}),
    status: row.status as SessionStatus,
    promptCount: row.prompt_count,
    meta: fromJson<Record<string, unknown>>(row.meta, {}),
  };
}

// Sessions a person did not have. A scheduled job's output is a fact about the
// job, not about the user, so consolidating it fills the belief layer with
// things nobody said.
//
// Matched on the opening prompt, anchored at the start, so someone writing
// about cron is not mistaken for cron.
const AUTOMATED = /^\s*\[cron:|^\s*<<autonomous-loop/;

export function isAutomatedSession(title: string | undefined): boolean {
  return title !== undefined && AUTOMATED.test(title);
}

export interface StartSessionInput {
  id: string;
  source?: string;
  project?: string;
  title?: string;
  ts?: number;
  meta?: Record<string, unknown>;
}

// Idempotent by session id: a hook may fire more than once for the same
// session, and the first arrival is the one that sets the start time.
export function startSession(db: DB, input: StartSessionInput): SessionRecord {
  const ts = input.ts ?? Date.now();
  db.prepare(
    `INSERT INTO session
       (id, source, project, project_name, title, started_ts, status, prompt_count, meta)
     VALUES
       (@id, @source, @project, @project_name, @title, @started_ts, 'active', 0, @meta)
     ON CONFLICT(id) DO UPDATE SET
       project      = COALESCE(excluded.project, session.project),
       project_name = COALESCE(excluded.project_name, session.project_name),
       title        = COALESCE(session.title, excluded.title)`,
  ).run({
    id: input.id,
    source: input.source ?? "claude-code",
    project: input.project ?? null,
    // project is already the name. The column is kept so a store written by an
    // earlier version, which held a path here, still has somewhere to display
    // from.
    project_name: input.project ?? null,
    title: input.title ?? null,
    started_ts: ts,
    meta: toJson(input.meta ?? {}),
  });
  return getSession(db, input.id) as SessionRecord;
}

export function endSession(db: DB, id: string, ts: number = Date.now()): void {
  db.prepare(
    `UPDATE session SET ended_ts = @ts, status = 'completed' WHERE id = @id`,
  ).run({ id, ts });
}

// The prompt counter is what lets a session be titled by its opening request
// and lets the viewer say "turn 4 of 11" without counting rows every time.
export function countPrompt(db: DB, id: string): number {
  db.prepare(
    `UPDATE session SET prompt_count = prompt_count + 1 WHERE id = @id`,
  ).run({ id });
  const row = db
    .prepare(`SELECT prompt_count AS n FROM session WHERE id = @id`)
    .get({ id }) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function setSessionTitle(db: DB, id: string, title: string): void {
  db.prepare(`UPDATE session SET title = @title WHERE id = @id`).run({
    id,
    title,
  });
}

export function getSession(db: DB, id: string): SessionRecord | undefined {
  const row = db.prepare(`SELECT * FROM session WHERE id = @id`).get({ id }) as
    | SessionRow
    | undefined;
  return row ? rowToRecord(row) : undefined;
}

export interface SessionQuery {
  project?: string;
  status?: SessionStatus;
  limit?: number;
  offset?: number;
}

export function listSessions(
  db: DB,
  query: SessionQuery = {},
): SessionRecord[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {
    limit: query.limit ?? 100,
    offset: query.offset ?? 0,
  };
  if (query.project !== undefined) {
    clauses.push("project = @project");
    params.project = query.project;
  }
  if (query.status !== undefined) {
    clauses.push("status = @status");
    params.status = query.status;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT * FROM session ${where}
        ORDER BY started_ts DESC LIMIT @limit OFFSET @offset`,
    )
    .all(params) as SessionRow[];
  return rows.map(rowToRecord);
}

// Every project the store has seen, most recently active first. This is the
// viewer's project filter and the MCP tools' scope hint.
export function listProjects(
  db: DB,
): Array<{ project: string; name: string; sessions: number; lastTs: number }> {
  const rows = db
    .prepare(
      `SELECT project,
              COALESCE(project_name, project) AS name,
              count(*) AS sessions,
              max(started_ts) AS last_ts
         FROM session
        WHERE project IS NOT NULL
        GROUP BY project
        ORDER BY last_ts DESC`,
    )
    .all() as Array<{
    project: string;
    name: string;
    sessions: number;
    last_ts: number;
  }>;
  return rows.map((r) => ({
    project: r.project,
    name: r.name,
    sessions: r.sessions,
    lastTs: r.last_ts,
  }));
}
