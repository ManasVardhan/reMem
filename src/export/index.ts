import type { DB } from "../db/client.js";
import type {
  BeliefRecord,
  EdgeRecord,
  ObservationRecord,
} from "../types/index.js";
import { listBeliefs } from "../beliefs/store.js";
import { readObservations } from "../ingest/index.js";

// Sovereignty is a design principle (DESIGN.md 6.1, 6.6): the user owns their
// data and can take the whole model of themselves with them. export() produces
// a self-contained, JSON-serializable snapshot of the entire kernel: the
// immutable ledger, the derived beliefs, the graph, and the provenance links
// that tie beliefs back to observations.
//
// Embeddings are emitted as plain number[] so the snapshot round-trips through
// JSON without binary handling. Nothing here mutates state.

export const SNAPSHOT_VERSION = 1;

// Observations/beliefs with embeddings widened to number[] for portability.
export type ExportedObservation = Omit<ObservationRecord, "embedding"> & {
  embedding: number[];
};
export type ExportedBelief = Omit<BeliefRecord, "embedding"> & {
  embedding: number[];
};

export interface ExportedProvenance {
  beliefId: string;
  observationId: string;
}

export interface KernelSnapshot {
  version: number;
  exportedTs: number;
  observations: ExportedObservation[];
  beliefs: ExportedBelief[];
  edges: EdgeRecord[];
  provenance: ExportedProvenance[];
}

function listAllEdges(db: DB): EdgeRecord[] {
  const rows = db
    .prepare(`SELECT * FROM edge ORDER BY ts ASC, src_id ASC, dst_id ASC`)
    .all() as {
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

function listAllProvenance(db: DB): ExportedProvenance[] {
  const rows = db
    .prepare(
      `SELECT belief_id, observation_id FROM provenance
       ORDER BY belief_id ASC, observation_id ASC`,
    )
    .all() as { belief_id: string; observation_id: string }[];
  return rows.map((r) => ({
    beliefId: r.belief_id,
    observationId: r.observation_id,
  }));
}

export function exportSnapshot(
  db: DB,
  now: number = Date.now(),
): KernelSnapshot {
  const observations = readObservations(db, {}).map((o) => ({
    ...o,
    embedding: Array.from(o.embedding),
  }));
  // All statuses: the snapshot is a complete export, not a recall view.
  const beliefs = listBeliefs(db, {}).map((b) => ({
    ...b,
    embedding: Array.from(b.embedding),
  }));
  return {
    version: SNAPSHOT_VERSION,
    exportedTs: now,
    observations,
    beliefs,
    edges: listAllEdges(db),
    provenance: listAllProvenance(db),
  };
}
