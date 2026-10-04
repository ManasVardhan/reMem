import type { DB } from "../db/client.js";
import type { BeliefRecord } from "../types/index.js";
import { listBeliefs, setBeliefStatus } from "../beliefs/store.js";

// Decay is deterministic and LLM-free. Confidence is time-discounted on read;
// a scheduled pass archives beliefs that have decayed below a floor. Nothing is
// truly lost: the ledger still holds the evidence, so an archived belief is
// reversible (re-consolidation or fresh reinforcement can revive it). Forgetting
// is a designed feature that keeps recall sharp and the model current.

export interface DecayOptions {
  now?: number;
  // Beliefs whose effective confidence falls below this are archived.
  archiveFloor?: number;
}

export interface DecayReport {
  scanned: number;
  archived: number;
}

const DEFAULT_ARCHIVE_FLOOR = 0.05;

// effective_confidence = base_confidence * exp(-decay_rate * (now - last_reinforced_ts))
// dt is clamped at 0 so a belief reinforced "in the future" (clock skew) never
// exceeds its base confidence.
export function effectiveConfidence(belief: BeliefRecord, now: number): number {
  const dt = Math.max(0, now - belief.lastReinforcedTs);
  return belief.confidence * Math.exp(-belief.decayRate * dt);
}

export interface EffectiveBelief extends BeliefRecord {
  effectiveConfidence: number;
}

export function withEffectiveConfidence(
  belief: BeliefRecord,
  now: number,
): EffectiveBelief {
  return { ...belief, effectiveConfidence: effectiveConfidence(belief, now) };
}

// Archive active beliefs that have decayed below the floor. Only active beliefs
// are touched: superseded beliefs stay as history, archived ones are already
// soft-deleted. Runs in a single transaction.
export function runDecay(db: DB, options: DecayOptions = {}): DecayReport {
  const now = options.now ?? Date.now();
  const floor = options.archiveFloor ?? DEFAULT_ARCHIVE_FLOOR;
  const active = listBeliefs(db, { status: "active" });

  let archived = 0;
  const run = db.transaction(() => {
    for (const belief of active) {
      if (effectiveConfidence(belief, now) < floor) {
        setBeliefStatus(db, belief.id, "archived");
        archived++;
      }
    }
  });
  run();

  return { scanned: active.length, archived };
}
