import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB } from "../db/client.js";
import type { Embedder } from "../embed/index.js";
import {
  embeddingToBlob,
  blobToEmbedding,
  toJson,
  fromJson,
} from "../db/serde.js";
import type {
  ContextSnapshot,
  ObservationInput,
  ObservationRecord,
} from "../types/index.js";

// Validate at the boundary. Ingest is the one place untrusted input enters, so
// we check it here and trust it everywhere downstream.
const observationInputSchema = z.object({
  id: z.string().min(1).optional(),
  ts: z.number().int().nonnegative().optional(),
  source: z.string().min(1),
  actor: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  contextSnapshot: z.record(z.unknown()).optional(),
  meta: z.record(z.unknown()).optional(),
});

interface ObservationRow {
  rowid?: number;
  id: string;
  ts: number;
  source: string;
  actor: string;
  content: string;
  embedding: Buffer;
  context_snapshot: string;
  meta: string;
}

function rowToRecord(row: ObservationRow): ObservationRecord {
  return {
    ...(row.rowid !== undefined ? { rowid: row.rowid } : {}),
    id: row.id,
    ts: row.ts,
    source: row.source,
    actor: row.actor as ObservationRecord["actor"],
    content: row.content,
    embedding: blobToEmbedding(row.embedding),
    contextSnapshot: fromJson<ContextSnapshot>(row.context_snapshot, {}),
    meta: fromJson<Record<string, unknown>>(row.meta, {}),
  };
}

// Ingest: normalize input into an observation, embed, append. No reasoning, no
// LLM. This must never block the assistant, so it stays cheap and synchronous
// apart from the embedding call.
export async function ingestObservation(
  db: DB,
  embedder: Embedder,
  input: ObservationInput,
): Promise<ObservationRecord> {
  const parsed = observationInputSchema.parse(input);
  const id = parsed.id ?? randomUUID();
  const ts = parsed.ts ?? Date.now();
  const embedding = await embedder.embed(parsed.content);

  const record: ObservationRecord = {
    id,
    ts,
    source: parsed.source,
    actor: parsed.actor,
    content: parsed.content,
    embedding,
    contextSnapshot: parsed.contextSnapshot ?? {},
    meta: parsed.meta ?? {},
  };

  db.prepare(
    `INSERT INTO observation
       (id, ts, source, actor, content, embedding, context_snapshot, meta)
     VALUES
       (@id, @ts, @source, @actor, @content, @embedding, @context_snapshot, @meta)`,
  ).run({
    id: record.id,
    ts: record.ts,
    source: record.source,
    actor: record.actor,
    content: record.content,
    embedding: embeddingToBlob(record.embedding),
    context_snapshot: toJson(record.contextSnapshot),
    meta: toJson(record.meta),
  });

  return record;
}

export interface ObservationQuery {
  since?: number;
  source?: string;
  limit?: number;
  // Resume after a row that was already handled, by insertion order.
  //
  // Neither timestamp nor id works here. Observations share milliseconds, so a
  // time cursor either repeats a row forever or drops its neighbours; and ids
  // are random, so at an equal timestamp a newly appended row can sort before
  // the mark and be skipped for good. rowid is the ledger's own append order:
  // strictly increasing, never reused, no ties.
  afterRowid?: number;
}

// The ledger's insertion order for a row, which is what a resumable pass over
// an append-only table needs to remember.
export function observationRowid(db: DB, id: string): number | undefined {
  const row = db
    .prepare(`SELECT rowid FROM observation WHERE id = @id`)
    .get({ id }) as { rowid: number } | undefined;
  return row?.rowid;
}

// Low-level read over the ledger. Ordered oldest-first so ingestion order is
// preserved for consolidation windows.
export function readObservations(
  db: DB,
  query: ObservationQuery = {},
): ObservationRecord[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (query.since !== undefined) {
    clauses.push("ts >= @since");
    params.since = query.since;
  }
  if (query.source !== undefined) {
    clauses.push("source = @source");
    params.source = query.source;
  }
  if (query.afterRowid !== undefined) {
    clauses.push("rowid > @afterRowid");
    params.afterRowid = query.afterRowid;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = query.limit !== undefined ? "LIMIT @limit" : "";
  if (query.limit !== undefined) params.limit = query.limit;

  // Ordered by append order within a timestamp rather than by id: two rows in
  // the same millisecond are returned in the order they were written, which is
  // the order they happened.
  const rows = db
    .prepare(
      `SELECT rowid, id, ts, source, actor, content, embedding, context_snapshot, meta
         FROM observation ${where}
         ORDER BY ts ASC, rowid ASC ${limit}`,
    )
    .all(params) as ObservationRow[];

  return rows.map(rowToRecord);
}

export function getObservation(
  db: DB,
  id: string,
): ObservationRecord | undefined {
  const row = db
    .prepare(
      `SELECT rowid, id, ts, source, actor, content, embedding, context_snapshot, meta
         FROM observation WHERE id = @id`,
    )
    .get({ id }) as ObservationRow | undefined;
  return row ? rowToRecord(row) : undefined;
}
