import type { DB } from "../db/client.js";
import {
  embeddingToBlob,
  blobToEmbedding,
  toJson,
  fromJson,
} from "../db/serde.js";
import type {
  BeliefKind,
  BeliefRecord,
  BeliefStatus,
  EdgeRecord,
  Scope,
} from "../types/index.js";

// The self entity: the user the kernel models. Most beliefs are about "user".
export const SELF_ENTITY_ID = "user";

// Canonical text used to embed a belief, so semantically-equal beliefs land near
// each other regardless of surface wording.
export function canonicalBeliefText(
  kind: BeliefKind,
  predicate: string,
  value: string,
): string {
  return `${kind} ${predicate} ${value}`;
}

interface BeliefRow {
  id: string;
  kind: string;
  subject: string;
  predicate: string;
  value: string;
  confidence: number;
  scope: string;
  created_ts: number;
  last_reinforced_ts: number;
  decay_rate: number;
  status: string;
  embedding: Buffer;
}

function rowToBelief(row: BeliefRow): BeliefRecord {
  return {
    id: row.id,
    kind: row.kind as BeliefKind,
    subject: row.subject,
    predicate: row.predicate,
    value: row.value,
    confidence: row.confidence,
    scope: fromJson<Scope>(row.scope, {}),
    createdTs: row.created_ts,
    lastReinforcedTs: row.last_reinforced_ts,
    decayRate: row.decay_rate,
    status: row.status as BeliefStatus,
    embedding: blobToEmbedding(row.embedding),
  };
}

export function insertBelief(db: DB, belief: BeliefRecord): void {
  db.prepare(
    `INSERT INTO belief
       (id, kind, subject, predicate, value, confidence, scope,
        created_ts, last_reinforced_ts, decay_rate, status, embedding)
     VALUES
       (@id, @kind, @subject, @predicate, @value, @confidence, @scope,
        @created_ts, @last_reinforced_ts, @decay_rate, @status, @embedding)`,
  ).run({
    id: belief.id,
    kind: belief.kind,
    subject: belief.subject,
    predicate: belief.predicate,
    value: belief.value,
    confidence: belief.confidence,
    scope: toJson(belief.scope),
    created_ts: belief.createdTs,
    last_reinforced_ts: belief.lastReinforcedTs,
    decay_rate: belief.decayRate,
    status: belief.status,
    embedding: embeddingToBlob(belief.embedding),
  });
}

export function getBelief(db: DB, id: string): BeliefRecord | undefined {
  const row = db.prepare(`SELECT * FROM belief WHERE id = @id`).get({ id }) as
    | BeliefRow
    | undefined;
  return row ? rowToBelief(row) : undefined;
}

export interface BeliefFilter {
  subject?: string;
  predicate?: string;
  kind?: BeliefKind;
  status?: BeliefStatus;
}

export function listBeliefs(db: DB, filter: BeliefFilter = {}): BeliefRecord[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.subject !== undefined) {
    clauses.push("subject = @subject");
    params.subject = filter.subject;
  }
  if (filter.predicate !== undefined) {
    clauses.push("predicate = @predicate");
    params.predicate = filter.predicate;
  }
  if (filter.kind !== undefined) {
    clauses.push("kind = @kind");
    params.kind = filter.kind;
  }
  if (filter.status !== undefined) {
    clauses.push("status = @status");
    params.status = filter.status;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT * FROM belief ${where}
       ORDER BY last_reinforced_ts DESC, id ASC`,
    )
    .all(params) as BeliefRow[];
  return rows.map(rowToBelief);
}

export function updateBeliefConfidence(
  db: DB,
  id: string,
  confidence: number,
  lastReinforcedTs: number,
): void {
  db.prepare(
    `UPDATE belief SET confidence = @confidence,
       last_reinforced_ts = @ts WHERE id = @id`,
  ).run({ id, confidence, ts: lastReinforcedTs });
}

export function updateBeliefScope(
  db: DB,
  id: string,
  scope: Scope,
  lastReinforcedTs: number,
): void {
  db.prepare(
    `UPDATE belief SET scope = @scope, last_reinforced_ts = @ts WHERE id = @id`,
  ).run({ id, scope: toJson(scope), ts: lastReinforcedTs });
}

export function setBeliefStatus(
  db: DB,
  id: string,
  status: BeliefStatus,
): void {
  db.prepare(`UPDATE belief SET status = @status WHERE id = @id`).run({
    id,
    status,
  });
}

// Explicit user erasure of a belief. Removes the belief, its provenance links,
// and any edges touching it. The underlying observations in the ledger are NOT
// touched: they are the immutable source of record, and full ledger erasure is a
// separate, privileged GDPR path. Returns false if the belief did not exist.
export function forgetBelief(db: DB, id: string): boolean {
  const exists = getBelief(db, id);
  if (!exists) return false;
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM provenance WHERE belief_id = @id`).run({ id });
    db.prepare(`DELETE FROM edge WHERE src_id = @id OR dst_id = @id`).run({
      id,
    });
    db.prepare(`DELETE FROM belief WHERE id = @id`).run({ id });
  });
  run();
  return true;
}

// --- provenance ---

export function addProvenance(
  db: DB,
  beliefId: string,
  observationIds: string[],
): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO provenance (belief_id, observation_id)
     VALUES (@belief_id, @observation_id)`,
  );
  for (const observationId of observationIds) {
    stmt.run({ belief_id: beliefId, observation_id: observationId });
  }
}

// An already-held belief saying the same thing, in the same place.
//
// Matched on subject, predicate, value, kind and scope. Scope has to be part of
// it: the same sentence said in two projects is two beliefs, and folding them
// into one would leave the belief scoped to whichever project happened to say
// it first, invisible in the other. Kind likewise carries a decay rate, so a
// preference must not reinforce a fact.
//
// Superseded beliefs are excluded: one of those lost to a specific successor,
// and reviving it by restating it would undo that.
export function findEquivalentBelief(
  db: DB,
  match: {
    subject: string;
    predicate: string;
    value: string;
    kind: string;
    scope: Scope;
  },
): BeliefRecord | undefined {
  const row = db
    .prepare(
      `SELECT id FROM belief
        WHERE subject = @subject AND predicate = @predicate
          AND value = @value AND kind = @kind AND scope = @scope
          AND status != 'superseded'
        ORDER BY confidence DESC LIMIT 1`,
    )
    .get({
      subject: match.subject,
      predicate: match.predicate,
      value: match.value,
      kind: match.kind,
      // Compared as stored. Two scopes that mean the same thing but were
      // written with different key order are treated as different, which errs
      // towards keeping both rather than merging two things wrongly.
      scope: toJson(match.scope),
    }) as { id: string } | undefined;
  return row ? getBelief(db, row.id) : undefined;
}

// The inverse of provenance: which beliefs rest on this observation. Walking
// every belief and reading its sources answers the same question in O(beliefs)
// queries, which is fine at 26 beliefs and not at 26,000.
export function beliefsFromObservation(
  db: DB,
  observationId: string,
): BeliefRecord[] {
  const ids = db
    .prepare(`SELECT belief_id FROM provenance WHERE observation_id = @id`)
    .all({ id: observationId }) as Array<{ belief_id: string }>;
  const out: BeliefRecord[] = [];
  for (const row of ids) {
    const belief = getBelief(db, row.belief_id);
    if (belief) out.push(belief);
  }
  return out;
}

export function getProvenanceObservationIds(
  db: DB,
  beliefId: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT observation_id FROM provenance WHERE belief_id = @belief_id
       ORDER BY observation_id ASC`,
    )
    .all({ belief_id: beliefId }) as { observation_id: string }[];
  return rows.map((r) => r.observation_id);
}

// --- edges (the graph) ---

export function addEdge(db: DB, edge: EdgeRecord): void {
  db.prepare(
    `INSERT INTO edge (src_id, dst_id, type, weight, ts)
     VALUES (@src_id, @dst_id, @type, @weight, @ts)
     ON CONFLICT(src_id, dst_id, type)
     DO UPDATE SET weight = excluded.weight, ts = excluded.ts`,
  ).run({
    src_id: edge.srcId,
    dst_id: edge.dstId,
    type: edge.type,
    weight: edge.weight,
    ts: edge.ts,
  });
}

export interface EdgeFilter {
  srcId?: string;
  dstId?: string;
  type?: string;
}

export function listEdges(db: DB, filter: EdgeFilter = {}): EdgeRecord[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.srcId !== undefined) {
    clauses.push("src_id = @srcId");
    params.srcId = filter.srcId;
  }
  if (filter.dstId !== undefined) {
    clauses.push("dst_id = @dstId");
    params.dstId = filter.dstId;
  }
  if (filter.type !== undefined) {
    clauses.push("type = @type");
    params.type = filter.type;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM edge ${where} ORDER BY ts ASC`)
    .all(params) as {
    src_id: string;
    dst_id: string;
    type: string;
    weight: number;
    ts: number;
  }[];
  return rows.map((r) => ({
    srcId: r.src_id,
    dstId: r.dst_id,
    type: r.type,
    weight: r.weight,
    ts: r.ts,
  }));
}
