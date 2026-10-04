import type { BeliefKind } from "../types/index.js";

// Per-kind decay half-lives. Identity facts and relationships decay glacially;
// preferences and goals are more ephemeral. The decay process (Phase 3) reads
// the stored per-belief decay_rate; belief creation stamps it from these
// defaults so the rate travels with the belief and stays tunable per row.

const MS_PER_DAY = 86_400_000;

// Half-life in days for each belief kind.
export const DEFAULT_HALF_LIVES_DAYS: Record<BeliefKind, number> = {
  fact: 3650, // ~10 years
  relationship: 3650,
  habit: 180,
  goal: 90,
  preference: 60,
};

// Convert a half-life to the lambda used by effective_confidence:
//   effective = base * exp(-lambda * dt_ms)
// so that after one half-life the multiplier is exactly 0.5.
export function decayRateFor(kind: BeliefKind): number {
  const halfLifeDays = DEFAULT_HALF_LIVES_DAYS[kind];
  return Math.LN2 / (halfLifeDays * MS_PER_DAY);
}
