// The viewer's read model over the whole store.
//
// snapshot.ts answers "what does memory believe". This answers "what happened",
// which is the view the viewer opens on: the ledger first, in the order it was
// written, with the derived accounts folded into the same stream.
//
// Every function here is a pure read. The viewer opens the store readonly and
// this module is the only thing that talks to it.

import { existsSync } from "node:fs";
import { openDb, hasFts } from "../db/client.js";
import { fromJson } from "../db/serde.js";
import { listBeliefs, getProvenanceObservationIds } from "../beliefs/store.js";
import { withEffectiveConfidence } from "../decay/index.js";
import { getObservation } from "../ingest/index.js";
import {
  listEpisodes,
  getEpisode,
  getEpisodeObservationIds,
} from "../episodes/index.js";
import { listSessions, listProjects, getSession } from "../sessions/index.js";
import { search as runSearch } from "../search/index.js";
import { classifyPrompt } from "../ingest/authored.js";
import type { DB } from "../db/client.js";
import type { EpisodeRecord, SessionRecord } from "../types/index.js";

// How much of an observation the feed carries. The rest arrives on click, so a
// long paste does not cost anything until someone actually wants to read it.
export const FEED_EXCERPT = 420;
export const FEED_PAGE = 40;

export type FeedKind = "prompt" | "scheduled" | "episode";

export interface FeedItem {
  kind: FeedKind;
  id: string;
  ts: number;
  project?: string;
  projectName?: string;
  sessionId?: string;
  // What was said or done.
  actor?: string;
  source?: string;
  excerpt?: string;
  truncated?: boolean;
  // A derived account.
  episodeKind?: string;
  title?: string;
  subtitle?: string;
  factCount?: number;
  fileCount?: number;
  // How many beliefs this observation is the evidence for.
  beliefCount?: number;
}

// The cursor into the merged feed. Both halves are needed: the stream is sorted
// by time and then by id, and a burst of tool calls inside one millisecond is
// ordinary, so a cursor of time alone stops dead at the first tie and strands
// everything behind it.
export interface FeedCursor {
  ts: number;
  id: string;
}

export interface FeedQuery {
  project?: string;
  sessionId?: string;
  kinds?: FeedKind[];
  before?: FeedCursor;
  limit?: number;
  // Prefixes marking routines whose text carries no marker of its own, for
  // rows recorded before origin was stamped.
  scheduledPrefixes?: readonly string[];
}

export interface FeedPage {
  items: FeedItem[];
  nextCursor?: FeedCursor;
  hasMore: boolean;
}

interface ObsRow {
  id: string;
  ts: number;
  actor: string;
  source: string;
  content: string;
  context_snapshot: string;
}

// Spread-in helper: an absent session leaves the key off entirely rather than
// setting it to undefined, which is what exactOptionalPropertyTypes asks for.
function withSession(
  db: DB,
  sessionId: string | undefined,
): { session?: SessionRecord } {
  if (!sessionId) return {};
  const session = getSession(db, sessionId);
  return session ? { session } : {};
}

function excerptOf(content: string): { excerpt: string; truncated: boolean } {
  const flat = content.trim();
  if (flat.length <= FEED_EXCERPT) return { excerpt: flat, truncated: false };
  return { excerpt: `${flat.slice(0, FEED_EXCERPT)}`, truncated: true };
}

// Every ledger row the feed shows was written by the user or by a routine
// acting for them. Rows from an earlier version that recorded the agent's own
// tool calls are filtered out rather than rendered, so the ledger reads as what
// it claims to be.
const LEDGER_ACTOR = "user";

// A routine's instructions are worth remembering and are not something the
// person said this morning, so they are shown as their own kind. Rows recorded
// before origin was stamped are classified from their text on the way out.
function originOf(
  ctx: Record<string, unknown>,
  content: string,
  scheduled: readonly string[],
): FeedKind {
  if (ctx.origin === "scheduled") return "scheduled";
  if (ctx.origin === "user") return "prompt";
  return classifyPrompt(content, scheduled)?.origin === "scheduled"
    ? "scheduled"
    : "prompt";
}

// The SQL form of "this row came from a routine".
//
// Filtering after the fetch looked right and was not: asking for scheduled runs
// returned one row out of sixteen, because the page had already been filled
// with recent typed prompts before the filter ran. The condition has to be in
// the query.
function scheduledCondition(
  prefixes: readonly string[],
  params: Record<string, unknown>,
): string {
  const tests = [
    // COALESCE, because a row recorded before origin was stamped returns NULL
    // here, and NOT(NULL OR false) is NULL rather than true: the negated form
    // of this condition silently matched nothing at all.
    "COALESCE(json_extract(context_snapshot, '$.origin'), '') = 'scheduled'",
    // Rows recorded before origin was stamped, recognised the same way the
    // classifier recognises them.
    "content LIKE '[cron:%'",
    "content LIKE '<<autonomous-loop%'",
  ];
  prefixes.forEach((prefix, i) => {
    const trimmed = prefix.trim();
    if (trimmed === "") return;
    tests.push(`content LIKE @sched${i}`);
    params[`sched${i}`] = `${trimmed}%`;
  });
  return `(${tests.join(" OR ")})`;
}

function observationItems(db: DB, q: FeedQuery, limit: number): FeedItem[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = { limit };
  if (q.before !== undefined) {
    clauses.push("(ts < @beforeTs OR (ts = @beforeTs AND id < @beforeId))");
    params.beforeTs = q.before.ts;
    params.beforeId = q.before.id;
  }
  if (q.project !== undefined) {
    clauses.push("json_extract(context_snapshot, '$.projectName') = @project");
    params.project = q.project;
  }
  if (q.sessionId !== undefined) {
    clauses.push("json_extract(context_snapshot, '$.sessionId') = @sessionId");
    params.sessionId = q.sessionId;
  }
  clauses.push("actor = @actor");
  params.actor = LEDGER_ACTOR;

  // Narrow in SQL when only one of the two origins was asked for.
  const kinds = q.kinds;
  if (kinds && !(kinds.includes("prompt") && kinds.includes("scheduled"))) {
    const condition = scheduledCondition(q.scheduledPrefixes ?? [], params);
    clauses.push(kinds.includes("scheduled") ? condition : `NOT ${condition}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT id, ts, actor, source, content, context_snapshot
         FROM observation ${where}
        ORDER BY ts DESC, id DESC LIMIT @limit`,
    )
    .all(params) as ObsRow[];

  if (rows.length === 0) return [];

  // One query for the whole page rather than one per row: this is the number
  // that makes the ledger worth reading, so it must not cost a round trip each.
  const placeholders = rows.map((_, i) => `@p${i}`).join(",");
  const provParams: Record<string, unknown> = {};
  rows.forEach((r, i) => {
    provParams[`p${i}`] = r.id;
  });
  const counts = new Map<string, number>();
  for (const row of db
    .prepare(
      `SELECT observation_id AS id, count(*) AS n FROM provenance
        WHERE observation_id IN (${placeholders}) GROUP BY observation_id`,
    )
    .all(provParams) as Array<{ id: string; n: number }>) {
    counts.set(row.id, row.n);
  }

  return rows.map((r) => {
    const ctx = fromJson<Record<string, unknown>>(r.context_snapshot, {});
    const { excerpt, truncated } = excerptOf(r.content);
    return {
      kind: originOf(ctx, r.content, q.scheduledPrefixes ?? []),
      id: r.id,
      ts: r.ts,
      ...(typeof ctx.project === "string" ? { project: ctx.project } : {}),
      ...(typeof ctx.projectName === "string"
        ? { projectName: ctx.projectName }
        : {}),
      ...(typeof ctx.sessionId === "string"
        ? { sessionId: ctx.sessionId }
        : {}),
      actor: r.actor,
      source: r.source,
      excerpt,
      truncated,
      beliefCount: counts.get(r.id) ?? 0,
    };
  });
}

function episodeItems(db: DB, q: FeedQuery, limit: number): FeedItem[] {
  const episodes = listEpisodes(db, {
    ...(q.project !== undefined ? { project: q.project } : {}),
    ...(q.sessionId !== undefined ? { sessionId: q.sessionId } : {}),
    ...(q.before !== undefined ? { before: q.before } : {}),
    limit,
  });
  return episodes.map((e) => ({
    kind: "episode" as const,
    id: e.id,
    ts: e.ts,
    ...(e.project ? { project: e.project, projectName: e.project } : {}),
    ...(e.sessionId ? { sessionId: e.sessionId } : {}),
    episodeKind: e.kind,
    title: e.title,
    ...(e.subtitle ? { subtitle: e.subtitle } : {}),
    factCount: e.facts.length,
    fileCount: e.filesRead.length + e.filesChanged.length,
  }));
}

// The feed: observations and episodes in one stream, newest first. Merged in
// memory because they live in different tables and a UNION over two different
// shapes costs more to maintain than it saves.
export function feed(db: DB, q: FeedQuery = {}): FeedPage {
  const limit = Math.min(q.limit ?? FEED_PAGE, 200);
  const kinds = q.kinds ?? ["prompt", "scheduled", "episode"];
  const wantObservations =
    kinds.includes("prompt") || kinds.includes("scheduled");

  // Over-fetch each source by a page so the merge has enough to fill one.
  let items: FeedItem[] = [];
  if (wantObservations) {
    items = items.concat(
      observationItems(db, q, limit + 1).filter((i) => kinds.includes(i.kind)),
    );
  }
  if (kinds.includes("episode")) {
    items = items.concat(episodeItems(db, q, limit + 1));
  }

  items.sort((a, b) =>
    b.ts === a.ts ? b.id.localeCompare(a.id) : b.ts - a.ts,
  );
  const page = items.slice(0, limit);
  const hasMore = items.length > limit;
  const last = page[page.length - 1];

  return {
    items: page,
    ...(hasMore && last ? { nextCursor: { ts: last.ts, id: last.id } } : {}),
    hasMore,
  };
}

// --- detail: the click-through ---

export interface ObservationDetail {
  kind: "observation";
  // Whether a person typed this or a routine submitted it.
  origin: FeedKind;
  id: string;
  ts: number;
  actor: string;
  source: string;
  content: string; // the whole thing, never truncated
  project?: string;
  projectName?: string;
  sessionId?: string;
  promptNumber?: number;
  session?: SessionRecord;
  // What this observation went on to justify. The reason the ledger is worth
  // clicking into: you can see what memory made of what you said.
  beliefs: Array<{
    id: string;
    predicate: string;
    value: string;
    status: string;
    confidence: number;
  }>;
  episodes: Array<{ id: string; title: string; kind: string; ts: number }>;
}

export function observationDetail(
  db: DB,
  id: string,
  scheduled: readonly string[] = [],
): ObservationDetail | undefined {
  const obs = getObservation(db, id);
  if (!obs) return undefined;

  const beliefs = db
    .prepare(
      `SELECT b.id, b.predicate, b.value, b.status, b.confidence
         FROM provenance p JOIN belief b ON b.id = p.belief_id
        WHERE p.observation_id = @id
        ORDER BY b.confidence DESC`,
    )
    .all({ id }) as ObservationDetail["beliefs"];

  const episodes = db
    .prepare(
      `SELECT e.id, e.title, e.kind, e.ts
         FROM episode_provenance ep JOIN episode e ON e.id = ep.episode_id
        WHERE ep.observation_id = @id
        ORDER BY e.ts DESC`,
    )
    .all({ id }) as ObservationDetail["episodes"];

  const ctx = obs.contextSnapshot as Record<string, unknown>;
  const sessionId =
    typeof ctx.sessionId === "string" ? ctx.sessionId : undefined;

  return {
    kind: "observation",
    origin: originOf(ctx, obs.content, scheduled),
    id: obs.id,
    ts: obs.ts,
    actor: obs.actor,
    source: obs.source,
    content: obs.content,
    ...(typeof ctx.project === "string" ? { project: ctx.project } : {}),
    ...(typeof ctx.projectName === "string"
      ? { projectName: ctx.projectName }
      : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(typeof ctx.promptNumber === "number"
      ? { promptNumber: ctx.promptNumber }
      : {}),
    ...withSession(db, sessionId),
    beliefs,
    episodes,
  };
}

export interface EpisodeDetail {
  kind: "episode";
  episode: EpisodeRecord;
  session?: SessionRecord;
  // The observations this account was drawn from, in full.
  observations: Array<{
    id: string;
    ts: number;
    actor: string;
    content: string;
  }>;
}

export function episodeDetail(db: DB, id: string): EpisodeDetail | undefined {
  const episode = getEpisode(db, id);
  if (!episode) return undefined;

  const observations = getEpisodeObservationIds(db, id)
    .map((oid) => getObservation(db, oid))
    .filter((o): o is NonNullable<typeof o> => o !== undefined)
    .map((o) => ({
      id: o.id,
      ts: o.ts,
      actor: o.actor as string,
      content: o.content,
    }));

  return {
    kind: "episode",
    episode,
    ...withSession(db, episode.sessionId),
    observations,
  };
}

export interface BeliefDetail {
  kind: "belief";
  id: string;
  predicate: string;
  value: string;
  status: string;
  confidence: number;
  effectiveConfidence: number;
  scope: Record<string, unknown>;
  createdTs: number;
  lastReinforcedTs: number;
  observations: Array<{
    id: string;
    ts: number;
    actor: string;
    content: string;
  }>;
}

export function beliefDetail(db: DB, id: string): BeliefDetail | undefined {
  const all = listBeliefs(db, {});
  const belief = all.find((b) => b.id === id);
  if (!belief) return undefined;
  const effective = withEffectiveConfidence(belief, Date.now());
  const observations = getProvenanceObservationIds(db, id)
    .map((oid) => getObservation(db, oid))
    .filter((o): o is NonNullable<typeof o> => o !== undefined)
    .map((o) => ({ id: o.id, ts: o.ts, actor: o.actor, content: o.content }));
  return {
    kind: "belief",
    id: belief.id,
    predicate: belief.predicate,
    value: belief.value,
    status: belief.status,
    confidence: belief.confidence,
    effectiveConfidence: effective.effectiveConfidence,
    scope: belief.scope as Record<string, unknown>,
    createdTs: belief.createdTs,
    lastReinforcedTs: belief.lastReinforcedTs,
    observations,
  };
}

// --- the band above the feed ---

export interface Overview {
  dbPath: string;
  counts: {
    observations: number;
    prompts: number;
    episodes: number;
    sessions: number;
    activeBeliefs: number;
    supersededBeliefs: number;
  };
  projects: Array<{
    project: string;
    name: string;
    sessions: number;
    lastTs: number;
  }>;
  beliefs: Array<{
    id: string;
    predicate: string;
    value: string;
    confidence: number;
    effectiveConfidence: number;
    status: string;
    scope: Record<string, unknown>;
    supersedes?: { value: string; id: string };
    observationCount: number;
  }>;
  hasFts: boolean;
  empty: boolean;
}

const TOP_BELIEFS = 60;

export function overview(
  db: DB,
  dbPathValue: string,
  project?: string,
): Overview {
  const count = (sql: string, params: Record<string, unknown> = {}): number =>
    (db.prepare(sql).get(params) as { n: number }).n;

  const projectFilter = project
    ? "WHERE json_extract(context_snapshot, '$.projectName') = @project"
    : "";
  const params = project ? { project } : {};

  const active = listBeliefs(db, { status: "active" });
  const superseded = listBeliefs(db, { status: "superseded" });

  // A superseded belief is only interesting next to the one that replaced it,
  // so pair them up by predicate here rather than in the page.
  const replacedBy = new Map<string, { value: string; id: string }>();
  for (const old of superseded) {
    const current = active.find(
      (a) => a.predicate === old.predicate && a.subject === old.subject,
    );
    if (current) replacedBy.set(current.id, { value: old.value, id: old.id });
  }

  const now = Date.now();
  // A belief with no project holds everywhere, so it belongs in every project's
  // view. One scoped to a project belongs only in that one.
  //
  // This compared with endsWith when scope held an absolute path. It holds the
  // project name now, and a suffix match on names is wrong: scoping to "mem"
  // would pull in everything belonging to "reMem".
  const scoped = active
    .filter((b) => {
      if (!project) return true;
      const scope = (b.scope as Record<string, unknown>).project;
      return scope === undefined || scope === project;
    })
    .map((b) => withEffectiveConfidence(b, now))
    .sort((a, b) => b.effectiveConfidence - a.effectiveConfidence)
    .slice(0, TOP_BELIEFS);

  const provCounts = new Map<string, number>();
  for (const row of db
    .prepare(
      `SELECT belief_id AS id, count(*) AS n FROM provenance GROUP BY belief_id`,
    )
    .all() as Array<{ id: string; n: number }>) {
    provCounts.set(row.id, row.n);
  }

  return {
    dbPath: dbPathValue,
    counts: {
      // Counted as what the ledger is for. Rows from an earlier version that
      // recorded the agent's tool calls are not part of that count.
      observations: count(
        `SELECT count(*) AS n FROM observation ${projectFilter ? `${projectFilter} AND` : "WHERE"} actor = 'user'`,
        params,
      ),
      prompts: count(
        `SELECT count(*) AS n FROM observation ${projectFilter ? `${projectFilter} AND` : "WHERE"} actor = 'user'`,
        params,
      ),
      episodes: count(
        project
          ? `SELECT count(*) AS n FROM episode WHERE project = @project`
          : `SELECT count(*) AS n FROM episode`,
        params,
      ),
      sessions: count(
        project
          ? `SELECT count(*) AS n FROM session WHERE project_name = @project OR project = @project`
          : `SELECT count(*) AS n FROM session`,
        params,
      ),
      activeBeliefs: active.length,
      supersededBeliefs: superseded.length,
    },
    projects: listProjects(db),
    beliefs: scoped.map((b) => ({
      id: b.id,
      predicate: b.predicate,
      value: b.value,
      confidence: b.confidence,
      effectiveConfidence: b.effectiveConfidence,
      status: b.status,
      scope: b.scope as Record<string, unknown>,
      ...(replacedBy.has(b.id) ? { supersedes: replacedBy.get(b.id)! } : {}),
      observationCount: provCounts.get(b.id) ?? 0,
    })),
    hasFts: hasFts(db),
    empty: count(`SELECT count(*) AS n FROM observation`) === 0,
  };
}

// --- sessions ---

export interface SessionView extends SessionRecord {
  observationCount: number;
  episodeCount: number;
}

export function sessions(db: DB, project?: string, limit = 50): SessionView[] {
  const rows = listSessions(db, {
    limit,
    ...(project ? { project } : {}),
  });
  return rows.map((s) => ({
    ...s,
    observationCount: (
      db
        .prepare(
          `SELECT count(*) AS n FROM observation
            WHERE json_extract(context_snapshot, '$.sessionId') = @id`,
        )
        .get({ id: s.id }) as { n: number }
    ).n,
    episodeCount: (
      db
        .prepare(`SELECT count(*) AS n FROM episode WHERE session_id = @id`)
        .get({ id: s.id }) as { n: number }
    ).n,
  }));
}

export function searchAll(
  db: DB,
  query: string,
  project?: string,
  limit = 40,
): ReturnType<typeof runSearch> {
  return runSearch(db, {
    query,
    ...(project ? { project } : {}),
    limit,
  });
}

// Open the store readonly for a single request. Per-call so the viewer always
// reflects the current state and never holds a lock against a live session.
export function withDb<T>(path: string, fn: (db: DB) => T): T | undefined {
  if (!existsSync(path)) return undefined;
  const db = openDb({ path, readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
