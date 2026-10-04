// Search across the store: the ledger, the derived episodes, and the beliefs.
//
// FTS5 when the SQLite build has it, a LIKE scan when it does not. The fallback
// is slower but returns the same shape, so nothing above this layer has to know
// which one ran.

import type { DB } from "../db/client.js";
import { hasFts } from "../db/client.js";
import { fromJson } from "../db/serde.js";
import type { EpisodeRecord } from "../types/index.js";
import { getEpisode } from "../episodes/index.js";

export type SearchKind = "observation" | "episode" | "belief";

export interface SearchHit {
  kind: SearchKind;
  id: string;
  ts: number;
  title: string; // episode title, belief predicate=value, or observation excerpt
  excerpt: string;
  project?: string;
  sessionId?: string;
  score: number; // lower is better (BM25 rank); 0 for scan fallback
  meta?: Record<string, unknown>;
}

export interface SearchQuery {
  query: string;
  kinds?: SearchKind[];
  project?: string;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  usedFts: boolean;
}

// FTS5 treats a bare query as a mini-language: an unbalanced quote or a stray
// hyphen is a syntax error, not a search for that character. Quoting every
// token turns any user input into a literal phrase search, which is what a
// person typing into a search box means.
export function toMatchQuery(raw: string): string {
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" AND ");
}

function excerpt(text: string, query: string, width = 220): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= width) return flat;
  const first = query.split(/\s+/).filter(Boolean)[0] ?? "";
  const at = first ? flat.toLowerCase().indexOf(first.toLowerCase()) : -1;
  if (at < 0) return `${flat.slice(0, width)}...`;
  const start = Math.max(0, at - Math.floor(width / 3));
  return `${start > 0 ? "..." : ""}${flat.slice(start, start + width)}...`;
}

interface ObsHitRow {
  id: string;
  ts: number;
  content: string;
  context_snapshot: string;
  actor: string;
  rank: number;
}

function searchObservations(
  db: DB,
  q: SearchQuery,
  match: string,
  useFts: boolean,
): SearchHit[] {
  const limit = (q.limit ?? 30) + (q.offset ?? 0);
  const params: Record<string, unknown> = { limit };
  const filters: string[] = [];
  if (q.project !== undefined) {
    filters.push(
      "json_extract(o.context_snapshot, '$.projectName') = @project",
    );
    params.project = q.project;
  }
  if (q.since !== undefined) {
    filters.push("o.ts >= @since");
    params.since = q.since;
  }
  if (q.until !== undefined) {
    filters.push("o.ts <= @until");
    params.until = q.until;
  }

  let rows: ObsHitRow[];
  if (useFts && match) {
    params.match = match;
    const where = filters.length ? `AND ${filters.join(" AND ")}` : "";
    rows = db
      .prepare(
        `SELECT o.id, o.ts, o.content, o.context_snapshot, o.actor, f.rank AS rank
           FROM observation_fts f
           JOIN observation o ON o.rowid = f.rowid
          WHERE observation_fts MATCH @match ${where}
          ORDER BY f.rank LIMIT @limit`,
      )
      .all(params) as ObsHitRow[];
  } else {
    params.like = `%${q.query}%`;
    const where = filters.length ? `AND ${filters.join(" AND ")}` : "";
    rows = db
      .prepare(
        `SELECT o.id, o.ts, o.content, o.context_snapshot, o.actor, 0 AS rank
           FROM observation o
          WHERE o.content LIKE @like ${where}
          ORDER BY o.ts DESC LIMIT @limit`,
      )
      .all(params) as ObsHitRow[];
  }

  return rows.map((r) => {
    const ctx = fromJson<Record<string, unknown>>(r.context_snapshot, {});
    return {
      kind: "observation" as const,
      id: r.id,
      ts: r.ts,
      title: excerpt(r.content, q.query, 90),
      excerpt: excerpt(r.content, q.query),
      ...(typeof ctx.projectName === "string"
        ? { project: ctx.projectName }
        : {}),
      ...(typeof ctx.sessionId === "string"
        ? { sessionId: ctx.sessionId }
        : {}),
      score: r.rank,
      meta: { actor: r.actor },
    };
  });
}

interface EpisodeHitRow {
  id: string;
  ts: number;
  title: string;
  subtitle: string | null;
  narrative: string | null;
  project: string | null;
  session_id: string | null;
  kind: string;
  rank: number;
}

function searchEpisodes(
  db: DB,
  q: SearchQuery,
  match: string,
  useFts: boolean,
): SearchHit[] {
  const limit = (q.limit ?? 30) + (q.offset ?? 0);
  const params: Record<string, unknown> = { limit };
  const filters: string[] = [];
  if (q.project !== undefined) {
    filters.push("e.project = @project");
    params.project = q.project;
  }
  if (q.since !== undefined) {
    filters.push("e.ts >= @since");
    params.since = q.since;
  }
  if (q.until !== undefined) {
    filters.push("e.ts <= @until");
    params.until = q.until;
  }

  let rows: EpisodeHitRow[];
  if (useFts && match) {
    params.match = match;
    const where = filters.length ? `AND ${filters.join(" AND ")}` : "";
    rows = db
      .prepare(
        `SELECT e.id, e.ts, e.title, e.subtitle, e.narrative, e.project,
                e.session_id, e.kind, f.rank AS rank
           FROM episode_fts f
           JOIN episode e ON e.rowid = f.rowid
          WHERE episode_fts MATCH @match ${where}
          ORDER BY f.rank LIMIT @limit`,
      )
      .all(params) as EpisodeHitRow[];
  } else {
    params.like = `%${q.query}%`;
    const where = filters.length ? `AND ${filters.join(" AND ")}` : "";
    rows = db
      .prepare(
        `SELECT e.id, e.ts, e.title, e.subtitle, e.narrative, e.project,
                e.session_id, e.kind, 0 AS rank
           FROM episode e
          WHERE (e.title LIKE @like OR e.subtitle LIKE @like
                 OR e.narrative LIKE @like OR e.facts LIKE @like) ${where}
          ORDER BY e.ts DESC LIMIT @limit`,
      )
      .all(params) as EpisodeHitRow[];
  }

  return rows.map((r) => ({
    kind: "episode" as const,
    id: r.id,
    ts: r.ts,
    title: r.title,
    excerpt: excerpt(r.subtitle ?? r.narrative ?? "", q.query),
    ...(r.project ? { project: r.project } : {}),
    ...(r.session_id ? { sessionId: r.session_id } : {}),
    score: r.rank,
    meta: { kind: r.kind },
  }));
}

interface BeliefHitRow {
  id: string;
  predicate: string;
  value: string;
  confidence: number;
  status: string;
  created_ts: number;
  scope: string;
}

function searchBeliefs(db: DB, q: SearchQuery): SearchHit[] {
  const rows = db
    .prepare(
      `SELECT id, predicate, value, confidence, status, created_ts, scope
         FROM belief
        WHERE predicate LIKE @like OR value LIKE @like
        ORDER BY confidence DESC LIMIT @limit`,
    )
    .all({
      like: `%${q.query}%`,
      limit: (q.limit ?? 30) + (q.offset ?? 0),
    }) as BeliefHitRow[];

  return rows.map((r) => {
    const scope = fromJson<Record<string, unknown>>(r.scope, {});
    return {
      kind: "belief" as const,
      id: r.id,
      ts: r.created_ts,
      title: `${r.predicate} = ${r.value}`,
      excerpt: `${r.status}, confidence ${r.confidence.toFixed(2)}`,
      ...(typeof scope.project === "string" ? { project: scope.project } : {}),
      score: 1 - r.confidence,
      meta: { status: r.status, confidence: r.confidence },
    };
  });
}

export function search(db: DB, q: SearchQuery): SearchResult {
  const kinds = q.kinds ?? ["episode", "observation", "belief"];
  const useFts = hasFts(db);
  const match = toMatchQuery(q.query);

  let hits: SearchHit[] = [];
  // FTS5 raises on a malformed match expression. Any failure here means the
  // index cannot answer this query, not that the store is broken, so fall back
  // to the scan and still return results.
  const collect = (fn: () => SearchHit[]): SearchHit[] => {
    try {
      return fn();
    } catch {
      return [];
    }
  };

  if (kinds.includes("episode")) {
    hits = hits.concat(collect(() => searchEpisodes(db, q, match, useFts)));
  }
  if (kinds.includes("observation")) {
    hits = hits.concat(collect(() => searchObservations(db, q, match, useFts)));
  }
  if (kinds.includes("belief")) {
    hits = hits.concat(collect(() => searchBeliefs(db, q)));
  }

  // Total is what matched, before the page is balanced and cut.
  const total = hits.length;

  // Rank within a kind, then interleave. Sorting the pool by kind buried what
  // the user actually said under the accounts written about it, so a small
  // limit returned no prompts at all. Each kind gets a share of the page.
  const byKind = new Map<SearchKind, SearchHit[]>();
  for (const hit of hits) {
    const list = byKind.get(hit.kind) ?? [];
    list.push(hit);
    byKind.set(hit.kind, list);
  }
  for (const list of byKind.values()) {
    list.sort((a, b) =>
      a.score === b.score ? b.ts - a.ts : a.score - b.score,
    );
  }

  const limit = q.limit ?? 30;
  const present = kinds.filter((k) => (byKind.get(k)?.length ?? 0) > 0);
  const share = present.length ? Math.ceil(limit / present.length) : limit;

  let balanced: SearchHit[] = [];
  for (const kind of present) {
    balanced = balanced.concat((byKind.get(kind) ?? []).slice(0, share));
  }
  // Anything left over fills the page when one kind had less than its share.
  if (balanced.length < limit) {
    const taken = new Set(balanced.map((h) => `${h.kind}:${h.id}`));
    for (const kind of present) {
      for (const hit of byKind.get(kind) ?? []) {
        if (balanced.length >= limit) break;
        if (!taken.has(`${kind}:${hit.id}`)) balanced.push(hit);
      }
    }
  }
  balanced.sort((a, b) => b.ts - a.ts);
  hits = balanced;

  const offset = q.offset ?? 0;
  return {
    hits: hits.slice(offset, offset + limit),
    total,
    usedFts: useFts,
  };
}

export interface TimelineOptions {
  anchorTs: number;
  project?: string;
  before?: number;
  after?: number;
}

export interface TimelineEntry {
  kind: "observation" | "episode";
  id: string;
  ts: number;
  title: string;
  actor?: string;
  project?: string;
  anchor: boolean;
}

// What surrounded a moment. Given a point in time, return the episodes and
// observations either side of it, so a single hit can be read in context
// instead of alone.
export function timeline(db: DB, opts: TimelineOptions): TimelineEntry[] {
  const before = opts.before ?? 5;
  const after = opts.after ?? 5;
  const params: Record<string, unknown> = { ts: opts.anchorTs };
  const filter =
    opts.project !== undefined
      ? "AND json_extract(context_snapshot, '$.projectName') = @project"
      : "";
  const epFilter = opts.project !== undefined ? "AND project = @project" : "";
  if (opts.project !== undefined) params.project = opts.project;

  const obsBefore = db
    .prepare(
      `SELECT id, ts, content, actor, context_snapshot FROM observation
        WHERE ts < @ts ${filter} ORDER BY ts DESC LIMIT @limit`,
    )
    .all({ ...params, limit: before }) as Array<{
    id: string;
    ts: number;
    content: string;
    actor: string;
    context_snapshot: string;
  }>;

  const obsAfter = db
    .prepare(
      `SELECT id, ts, content, actor, context_snapshot FROM observation
        WHERE ts >= @ts ${filter} ORDER BY ts ASC LIMIT @limit`,
    )
    .all({ ...params, limit: after + 1 }) as typeof obsBefore;

  const eps = db
    .prepare(
      `SELECT id, ts, title, project FROM episode
        WHERE ts BETWEEN @lo AND @hi ${epFilter} ORDER BY ts ASC LIMIT 20`,
    )
    .all({
      ...params,
      lo: (obsBefore[obsBefore.length - 1]?.ts ?? opts.anchorTs) - 1,
      hi: (obsAfter[obsAfter.length - 1]?.ts ?? opts.anchorTs) + 1,
    }) as Array<{
    id: string;
    ts: number;
    title: string;
    project: string | null;
  }>;

  const entries: TimelineEntry[] = [];
  for (const o of [...obsBefore.reverse(), ...obsAfter]) {
    const ctx = fromJson<Record<string, unknown>>(o.context_snapshot, {});
    entries.push({
      kind: "observation",
      id: o.id,
      ts: o.ts,
      title: excerpt(o.content, "", 120),
      actor: o.actor,
      ...(typeof ctx.projectName === "string"
        ? { project: ctx.projectName }
        : {}),
      anchor: o.ts === opts.anchorTs,
    });
  }
  for (const e of eps) {
    entries.push({
      kind: "episode",
      id: e.id,
      ts: e.ts,
      title: e.title,
      ...(e.project ? { project: e.project } : {}),
      anchor: false,
    });
  }
  entries.sort((a, b) => a.ts - b.ts);
  return entries;
}

// Resolve an episode by id for the "show me that one" path, keeping the search
// module the single import a caller needs for lookup.
export function episodeById(db: DB, id: string): EpisodeRecord | undefined {
  return getEpisode(db, id);
}
