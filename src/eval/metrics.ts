import type { EvalCase, Retrieval } from "./types.js";

// Retrieval-grounded, model-free metrics. Every number here is computable from
// (gold ids, answerable flag) and what a system returned, so the whole harness
// runs offline and deterministically. QA answer-correctness against external
// datasets is a separate, model-judged axis (see the Judge interface).

// recall@k: did any gold observation appear in the top k? Averaged over the
// answerable cases only (unanswerable cases have no gold to recall).
export function recallAtK(ranked: string[], gold: string[], k: number): number {
  if (gold.length === 0) return 0;
  const goldSet = new Set(gold);
  const top = ranked.slice(0, k);
  return top.some((id) => goldSet.has(id)) ? 1 : 0;
}

// Reciprocal rank of the first gold hit; 0 if none is retrieved. MRR is the
// mean of this over answerable cases.
export function reciprocalRank(ranked: string[], gold: string[]): number {
  const goldSet = new Set(gold);
  for (let i = 0; i < ranked.length; i++) {
    if (goldSet.has(ranked[i] as string)) return 1 / (i + 1);
  }
  return 0;
}

// The single number that captures the memory layer's job on a case:
// - answerable: the top-ranked observation is a gold (current) supporting one.
//   This punishes surfacing the superseded fact on knowledge-update cases and
//   the wrong-scope fact on scope cases, which is where naive vector loses.
// - unanswerable: the system abstained. Guessing is wrong even if it returns
//   nothing gold-y, because a confident non-abstention is a hallucination risk.
export function isGrounded(evalCase: EvalCase, r: Retrieval): boolean {
  if (!evalCase.answerable) return r.abstain;
  if (r.abstain) return false;
  const gold = new Set(evalCase.goldObservationIds);
  const top = r.rankedObservationIds[0];
  return top !== undefined && gold.has(top);
}

// Abstention treated as a binary classifier over cases: positive = "should
// abstain" = unanswerable. Precision and recall are reported separately because
// they trade off: a system that abstains on everything has perfect recall and
// poor precision. ReMem aims for high precision (it abstains when it should)
// without collapsing recall on answerable cases.
export interface AbstentionCounts {
  truePositive: number; // abstained on an unanswerable case (correct)
  falsePositive: number; // abstained on an answerable case (missed a real answer)
  falseNegative: number; // did not abstain on an unanswerable case (guessed)
}

export function abstentionCounts(
  evalCase: EvalCase,
  r: Retrieval,
): AbstentionCounts {
  const shouldAbstain = !evalCase.answerable;
  return {
    truePositive: shouldAbstain && r.abstain ? 1 : 0,
    falsePositive: !shouldAbstain && r.abstain ? 1 : 0,
    falseNegative: shouldAbstain && !r.abstain ? 1 : 0,
  };
}

export function precision(counts: AbstentionCounts): number {
  const denom = counts.truePositive + counts.falsePositive;
  return denom === 0 ? 1 : counts.truePositive / denom;
}

export function recall(counts: AbstentionCounts): number {
  const denom = counts.truePositive + counts.falseNegative;
  return denom === 0 ? 1 : counts.truePositive / denom;
}

export function sumCounts(list: AbstentionCounts[]): AbstentionCounts {
  return list.reduce(
    (acc, c) => ({
      truePositive: acc.truePositive + c.truePositive,
      falsePositive: acc.falsePositive + c.falsePositive,
      falseNegative: acc.falseNegative + c.falseNegative,
    }),
    { truePositive: 0, falsePositive: 0, falseNegative: 0 },
  );
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
