import { ReMemKernel } from "../kernel.js";
import type { Embedder } from "../embed/index.js";
import type { Consolidator } from "../consolidate/consolidator.js";
import type { ContextPack, RecallOptions } from "../recall/index.js";
import type { EvalCase, MemorySystem, Retrieval } from "./types.js";

// How a recalled ContextPack is flattened into a ranked observation-id list.
// - beliefs-first: belief provenance ahead of raw observation hits (the model of
//   the user leads). Maximizes recall breadth but can bury the exact gold
//   supporting observation below a belief's first-listed justification, which
//   costs top-1 grounding (see docs/FINDINGS.md F1).
// - observations-first: raw observation hits lead, belief provenance fills in.
// - blended: interleave both by pack score, highest first.
export type RankMode = "beliefs-first" | "observations-first" | "blended";

interface RankedId {
  evalId: string;
  score: number;
}

// Map a recalled ContextPack back to eval-dataset observation ids. Belief
// provenance ids are resolved through why() to the observations that justify
// each belief and carry that belief's pack score; raw observation hits carry
// their own. The mode fixes the ordering; results are deduped so a fact surfaced
// via both a belief and a raw hit counts once. Shared by the per-case
// ReMemSystem and the shared-store LoCoMo driver so both reMem paths score
// identically.
export function rankPackToEvalIds(
  kernel: ReMemKernel,
  pack: ContextPack,
  kernelToEval: Map<string, string>,
  mode: RankMode = "beliefs-first",
): string[] {
  const beliefProv: RankedId[] = [];
  for (const belief of pack.beliefs) {
    const prov = kernel.why(belief.id).observations;
    for (const obs of prov) {
      const evalId = kernelToEval.get(obs.id);
      if (evalId) beliefProv.push({ evalId, score: belief.score });
    }
  }
  const rawObs: RankedId[] = [];
  for (const obs of pack.observations) {
    const evalId = kernelToEval.get(obs.id);
    if (evalId) rawObs.push({ evalId, score: obs.score });
  }

  let ordered: RankedId[];
  if (mode === "observations-first") {
    ordered = [...rawObs, ...beliefProv];
  } else if (mode === "blended") {
    // Stable sort keeps belief-before-observation order on ties. Belief scores
    // are attenuated by confidence/recency/scope, so a raw hit of equal hybrid
    // relevance tends to outrank its own provenance here, which is the point.
    ordered = [...beliefProv, ...rawObs].sort((a, b) => b.score - a.score);
  } else {
    ordered = [...beliefProv, ...rawObs];
  }

  const ranked: string[] = [];
  const seen = new Set<string>();
  for (const { evalId } of ordered) {
    if (seen.has(evalId)) continue;
    seen.add(evalId);
    ranked.push(evalId);
  }
  return ranked;
}

// Rough token estimate shared across systems so cost comparisons are on one
// scale (about 4 chars per token).
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function cosine(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += (a[i] as number) * (b[i] as number);
  return dot;
}

// Baseline (a): no memory. Nothing is retrieved, so the answering model has no
// context and the only honest behavior is to abstain. This is the cost floor
// and the accuracy floor on answerable questions.
export class NoMemorySystem implements MemorySystem {
  readonly name = "no-memory";
  async retrieve(_evalCase: EvalCase): Promise<Retrieval> {
    return { rankedObservationIds: [], contextTokens: 0, abstain: true };
  }
}

// Baseline (b): full-context stuffing. Every observation is placed in the
// prompt, newest first (a long-context model attends to the latest mention).
// This is the accuracy ceiling on answerable questions and the cost ceiling. It
// has no abstention mechanism: it always ships context.
export class FullContextSystem implements MemorySystem {
  readonly name = "full-context";
  async retrieve(evalCase: EvalCase): Promise<Retrieval> {
    const ordered = [...evalCase.observations].sort((a, b) => b.ts - a.ts);
    const tokens = estimateTokens(ordered.map((o) => o.content).join("\n"));
    return {
      rankedObservationIds: ordered.map((o) => o.id),
      contextTokens: tokens,
      abstain: false,
    };
  }
}

// Baseline (c): naive vector-RAG (mem0-style). Embed everything, retrieve the
// top-k by cosine similarity, stuff those. No recency, no scope, no
// supersession, and no notion of "nothing is relevant", so it always returns
// its top-k even for unanswerable questions.
export class NaiveVectorSystem implements MemorySystem {
  readonly name = "naive-vector";
  constructor(
    private readonly embedder: Embedder,
    private readonly k: number = 3,
  ) {}

  async retrieve(evalCase: EvalCase): Promise<Retrieval> {
    const queryEmbedding = await this.embedder.embed(evalCase.query);
    const scored: { id: string; content: string; sim: number }[] = [];
    for (const obs of evalCase.observations) {
      const emb = await this.embedder.embed(obs.content);
      scored.push({
        id: obs.id,
        content: obs.content,
        sim: cosine(queryEmbedding, emb),
      });
    }
    scored.sort((a, b) => b.sim - a.sim || a.id.localeCompare(b.id));
    const top = scored.slice(0, this.k);
    return {
      rankedObservationIds: top.map((s) => s.id),
      contextTokens: estimateTokens(top.map((s) => s.content).join("\n")),
      abstain: false,
    };
  }
}

// ReMem: observe -> consolidate -> recall. A fresh kernel per case keeps runs
// isolated. Consolidation is incremental (observe then consolidate each
// observation in time order) so the supersession path fires on updates. The
// returned pack's beliefs are resolved back to their provenance observations so
// retrieval metrics compare like-for-like with the baselines.
export class ReMemSystem implements MemorySystem {
  readonly name = "reMem";
  // recallOptions overrides the recall defaults per run. The synthetic harness
  // keeps alpha=1 (pure BM25) because the HashingEmbedder's vector noise floor
  // defeats clean abstention; a real-embedder run (e.g. LoCoMo) passes the hybrid
  // default plus a minScore floor so the vector signal and abstention are used.
  private readonly recallOptions: RecallOptions;
  constructor(
    private readonly embedder: Embedder,
    private readonly makeConsolidator: () => Consolidator,
    recallOptions: RecallOptions = { alpha: 1 },
  ) {
    this.recallOptions = recallOptions;
  }

  async retrieve(evalCase: EvalCase): Promise<Retrieval> {
    const kernel = new ReMemKernel({
      // LoCoMo and PrefEval are dialogues between two people. The ledger is
      // user-only by default because an agent's output is not evidence about
      // the user; a corpus of real speakers is the exception, and saying so
      // here is the deliberate act that default is meant to force.
      ledgerActors: ["user", "assistant", "system"],
      embedder: this.embedder,
      consolidator: this.makeConsolidator(),
    });
    try {
      const ordered = [...evalCase.observations].sort((a, b) => a.ts - b.ts);
      const kernelToEval = new Map<string, string>();
      let maxTs = 0;
      for (const obs of ordered) {
        const input: Parameters<ReMemKernel["observe"]>[0] = {
          source: obs.source,
          actor: obs.actor,
          content: obs.content,
          ts: obs.ts,
        };
        if (obs.contextSnapshot) input.contextSnapshot = obs.contextSnapshot;
        const record = await kernel.observe(input);
        kernelToEval.set(record.id, obs.id);
        await kernel.consolidate({ since: obs.ts, now: obs.ts });
        if (obs.ts > maxTs) maxTs = obs.ts;
      }

      // Recall options come from the run (see the constructor note): pure BM25
      // for the hermetic HashingEmbedder harness, hybrid + minScore for a real
      // embedder run.
      const pack = await kernel.recall(evalCase.query, evalCase.context, {
        now: maxTs,
        ...this.recallOptions,
      });

      return {
        rankedObservationIds: rankPackToEvalIds(kernel, pack, kernelToEval),
        contextTokens: pack.tokensEstimate,
        abstain: pack.abstained,
      };
    } finally {
      kernel.close();
    }
  }
}
