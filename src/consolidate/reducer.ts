import { randomUUID } from "node:crypto";
import type { DB } from "../db/client.js";
import type { Embedder } from "../embed/index.js";
import type { BeliefRecord, Scope } from "../types/index.js";
import { decayRateFor } from "../beliefs/rates.js";
import {
  SELF_ENTITY_ID,
  canonicalBeliefText,
  getBelief,
  insertBelief,
  updateBeliefConfidence,
  updateBeliefScope,
  setBeliefStatus,
  addProvenance,
  addEdge,
  findEquivalentBelief,
} from "../beliefs/store.js";
import type { BeliefOp } from "./ops.js";

export interface ReducerOptions {
  // Minimum confidence for a CREATE to be admitted. Below this, the op is
  // dropped to avoid belief spam from one-off remarks.
  createFloor?: number;
  now?: number;
}

export interface ConsolidationReport {
  created: number;
  reinforced: number;
  contradicted: number;
  refined: number;
  nooped: number;
  // CREATE ops rejected by the confidence floor.
  dropped: number;
  // Ops referencing a belief id that does not exist.
  invalid: number;
}

const DEFAULT_CREATE_FLOOR = 0.35;

// Saturating reinforcement toward 1: repeated agreement raises confidence but
// never overshoots. new = 1 - (1 - c)(1 - delta).
function reinforceConfidence(current: number, delta: number): number {
  return 1 - (1 - current) * (1 - delta);
}

// Apply a batch of belief ops deterministically. The LLM has already proposed;
// this function is the sole authority that mutates belief state, and given the
// same ops and starting state it always produces the same result.
//
// Embeddings for new beliefs (CREATE/CONTRADICT) are computed up front so the
// actual mutations can run inside a single synchronous transaction, keeping the
// batch atomic.
export async function applyOps(
  db: DB,
  embedder: Embedder,
  ops: BeliefOp[],
  options: ReducerOptions = {},
): Promise<ConsolidationReport> {
  const now = options.now ?? Date.now();
  const createFloor = options.createFloor ?? DEFAULT_CREATE_FLOOR;

  // Pre-compute embeddings (async) before the sync transaction.
  const embeddings = new Map<number, Float32Array>();
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.op === "CREATE") {
      if (op.confidence < createFloor) continue; // will be dropped; skip embed
      embeddings.set(
        i,
        await embedder.embed(
          canonicalBeliefText(op.kind, op.predicate, op.value),
        ),
      );
    } else if (op.op === "CONTRADICT") {
      const old = getBelief(db, op.beliefId);
      if (!old) continue; // will be invalid; skip embed
      embeddings.set(
        i,
        await embedder.embed(
          canonicalBeliefText(old.kind, old.predicate, op.newValue),
        ),
      );
    }
  }

  const report: ConsolidationReport = {
    created: 0,
    reinforced: 0,
    contradicted: 0,
    refined: 0,
    nooped: 0,
    dropped: 0,
    invalid: 0,
  };

  const run = db.transaction(() => {
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!;
      switch (op.op) {
        case "CREATE": {
          if (op.confidence < createFloor) {
            report.dropped++;
            break;
          }

          // The same statement can reach a CREATE twice: a window is
          // consolidated again after an interrupted pass, or a session pass and
          // an incremental pass both cover it. Storing it twice would leave the
          // belief layer with duplicate rows that decay and supersede
          // independently, so an agreement with something already held is
          // reinforcement, which is what a second sighting actually is.
          const existing = findEquivalentBelief(db, {
            subject: op.subject ?? SELF_ENTITY_ID,
            predicate: op.predicate,
            value: op.value,
            kind: op.kind,
            scope: (op.scope ?? {}) as Scope,
          });
          if (existing) {
            updateBeliefConfidence(
              db,
              existing.id,
              reinforceConfidence(existing.confidence, 0.05),
              now,
            );
            if (existing.status === "archived") {
              setBeliefStatus(db, existing.id, "active");
            }
            addProvenance(db, existing.id, op.evidence);
            report.reinforced++;
            break;
          }

          const belief: BeliefRecord = {
            id: randomUUID(),
            kind: op.kind,
            subject: op.subject ?? SELF_ENTITY_ID,
            predicate: op.predicate,
            value: op.value,
            confidence: op.confidence,
            scope: (op.scope ?? {}) as Scope,
            createdTs: now,
            lastReinforcedTs: now,
            decayRate: decayRateFor(op.kind),
            status: "active",
            embedding: embeddings.get(i)!,
          };
          insertBelief(db, belief);
          addProvenance(db, belief.id, op.evidence);
          report.created++;
          break;
        }
        case "REINFORCE": {
          const belief = getBelief(db, op.beliefId);
          if (!belief) {
            report.invalid++;
            break;
          }
          updateBeliefConfidence(
            db,
            belief.id,
            reinforceConfidence(belief.confidence, op.delta),
            now,
          );
          // Fresh agreement revives a belief that decay had archived. A
          // superseded belief is not revived: it lost to a specific successor.
          if (belief.status === "archived") {
            setBeliefStatus(db, belief.id, "active");
          }
          addProvenance(db, belief.id, op.evidence);
          report.reinforced++;
          break;
        }
        case "CONTRADICT": {
          const old = getBelief(db, op.beliefId);
          if (!old) {
            report.invalid++;
            break;
          }
          const belief: BeliefRecord = {
            id: randomUUID(),
            kind: old.kind,
            subject: old.subject,
            predicate: old.predicate,
            value: op.newValue,
            confidence: op.confidence ?? old.confidence,
            scope: (op.scope ?? old.scope) as Scope,
            createdTs: now,
            lastReinforcedTs: now,
            decayRate: old.decayRate,
            status: "active",
            embedding: embeddings.get(i)!,
          };
          insertBelief(db, belief);
          addProvenance(db, belief.id, op.evidence);
          // Supersede, do not delete: the old belief stays for provenance and
          // recomputation, marked superseded, with an edge recording the link.
          setBeliefStatus(db, old.id, "superseded");
          addEdge(db, {
            srcId: belief.id,
            dstId: old.id,
            type: "supersedes",
            weight: 1,
            ts: now,
          });
          report.contradicted++;
          break;
        }
        case "REFINE": {
          const belief = getBelief(db, op.beliefId);
          if (!belief) {
            report.invalid++;
            break;
          }
          // Narrow: merge the tighter scope over the existing one.
          const narrowed: Scope = { ...belief.scope, ...op.narrowerScope };
          updateBeliefScope(db, belief.id, narrowed, now);
          addProvenance(db, belief.id, op.evidence);
          report.refined++;
          break;
        }
        case "NOOP": {
          report.nooped++;
          break;
        }
      }
    }
  });

  run();
  return report;
}
