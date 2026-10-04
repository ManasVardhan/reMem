import type { Ability, EvalDataset, MemorySystem } from "./types.js";
import {
  abstentionCounts,
  isGrounded,
  mean,
  precision,
  recall,
  recallAtK,
  reciprocalRank,
  sumCounts,
  type AbstentionCounts,
} from "./metrics.js";

export interface RunOptions {
  // The k for recall@k. Small by design: a memory pack that needs a deep list
  // to surface the answer is not doing its job.
  k?: number;
}

// Per-ability breakdown so the story is legible: which system wins where. This
// is the crux of the comparison, e.g. naive vector matches ReMem on plain
// extraction but loses on knowledge_update and abstention.
export interface AbilityMetrics {
  ability: Ability;
  cases: number;
  groundedAccuracy: number;
}

export interface SystemMetrics {
  system: string;
  cases: number;
  recallAtK: number;
  mrr: number;
  groundedAccuracy: number;
  abstentionPrecision: number;
  abstentionRecall: number;
  avgContextTokens: number;
  avgLatencyMs: number;
  byAbility: AbilityMetrics[];
}

export interface EvalReport {
  dataset: string;
  k: number;
  generatedTs: number;
  systems: SystemMetrics[];
}

const DEFAULT_K = 5;

function abilities(dataset: EvalDataset): Ability[] {
  const seen = new Set<Ability>();
  const order: Ability[] = [];
  for (const c of dataset.cases) {
    if (!seen.has(c.ability)) {
      seen.add(c.ability);
      order.push(c.ability);
    }
  }
  return order;
}

async function evaluateSystem(
  system: MemorySystem,
  dataset: EvalDataset,
  k: number,
): Promise<SystemMetrics> {
  const recallScores: number[] = [];
  const rrScores: number[] = [];
  const grounded: number[] = [];
  const tokens: number[] = [];
  const latencies: number[] = [];
  const counts: AbstentionCounts[] = [];
  const groundedByAbility = new Map<Ability, number[]>();

  for (const evalCase of dataset.cases) {
    const start = performance.now();
    const retrieval = await system.retrieve(evalCase);
    latencies.push(performance.now() - start);

    // Retrieval-order metrics apply to answerable cases only.
    if (evalCase.answerable) {
      recallScores.push(
        recallAtK(
          retrieval.rankedObservationIds,
          evalCase.goldObservationIds,
          k,
        ),
      );
      rrScores.push(
        reciprocalRank(
          retrieval.rankedObservationIds,
          evalCase.goldObservationIds,
        ),
      );
    }

    const g = isGrounded(evalCase, retrieval) ? 1 : 0;
    grounded.push(g);
    const bucket = groundedByAbility.get(evalCase.ability) ?? [];
    bucket.push(g);
    groundedByAbility.set(evalCase.ability, bucket);

    tokens.push(retrieval.contextTokens);
    counts.push(abstentionCounts(evalCase, retrieval));
  }

  const totalCounts = sumCounts(counts);
  const byAbility: AbilityMetrics[] = abilities(dataset).map((ability) => {
    const scores = groundedByAbility.get(ability) ?? [];
    return {
      ability,
      cases: scores.length,
      groundedAccuracy: mean(scores),
    };
  });

  return {
    system: system.name,
    cases: dataset.cases.length,
    recallAtK: mean(recallScores),
    mrr: mean(rrScores),
    groundedAccuracy: mean(grounded),
    abstentionPrecision: precision(totalCounts),
    abstentionRecall: recall(totalCounts),
    avgContextTokens: mean(tokens),
    avgLatencyMs: mean(latencies),
    byAbility,
  };
}

// Runs every system over the dataset and returns a structured report. Systems
// are evaluated in order (not concurrently) so latency numbers are not skewed
// by contention; each case is isolated inside the system, so results are
// order-independent.
export async function runEval(
  dataset: EvalDataset,
  systems: MemorySystem[],
  options: RunOptions = {},
): Promise<EvalReport> {
  const k = options.k ?? DEFAULT_K;
  const results: SystemMetrics[] = [];
  for (const system of systems) {
    results.push(await evaluateSystem(system, dataset, k));
  }
  return {
    dataset: dataset.name,
    k,
    generatedTs: Date.now(),
    systems: results,
  };
}
