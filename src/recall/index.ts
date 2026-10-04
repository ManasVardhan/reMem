import type { DB } from "../db/client.js";
import type { Embedder } from "../embed/index.js";
import type {
  BeliefRecord,
  ContextSnapshot,
  ObservationRecord,
  Scope,
} from "../types/index.js";
import {
  listBeliefs,
  listEdges,
  canonicalBeliefText,
  getProvenanceObservationIds,
} from "../beliefs/store.js";
import { readObservations } from "../ingest/index.js";
import { effectiveConfidence } from "../decay/index.js";
import { Bm25Index } from "./bm25.js";

// Recall is the read path (DESIGN.md 4.4). Given a query and the current
// context it returns a compact, ranked ContextPack rather than a dump:
//
//   1. scope filter    - drop beliefs whose scope is incompatible with context
//   2. hybrid recall   - BM25 + vector over beliefs and a few raw observations
//   3. graph expansion - pull beliefs 1-2 hops out over the edge table
//   4. score           - semantic_sim * effective_confidence * recency * scope
//   5. select          - reranker keeps what fits the intent (pluggable)
//   6. pack            - render within a budget, or abstain if nothing scores
//
// It stays deterministic and offline: the vector half is cosine over stored
// embeddings, the keyword half is the local BM25 index. The intent-aware
// reranker is pluggable so an LLM step can be dropped in without touching the
// scoring core.

// The situation a query is issued in. Mirrors ContextSnapshot: an absent
// dimension means "unspecified", which never excludes a scoped belief.
export type RecallContext = ContextSnapshot;

export interface ScoredBelief {
  belief: BeliefRecord;
  // Time-decayed confidence at recall time.
  effectiveConfidence: number;
  // Normalized keyword (BM25) and vector similarities, both 0..1.
  bm25: number;
  vector: number;
  recency: number;
  scopeMatch: number;
  // The lexical/vector blend before confidence, recency, and scope
  // attenuation. On the same scale as observation scores.
  hybrid: number;
  // Final combined score.
  score: number;
  // True when the belief entered the candidate set via graph expansion rather
  // than direct hybrid recall.
  viaGraph: boolean;
}

export interface ScoredObservation {
  observation: ObservationRecord;
  bm25: number;
  vector: number;
  score: number;
}

export interface PackedBelief {
  id: string;
  kind: BeliefRecord["kind"];
  predicate: string;
  value: string;
  scope: Scope;
  confidence: number;
  // The lexical/vector blend before confidence, recency, and scope
  // attenuation. On the same scale as PackedObservation.score, so the two can
  // be compared or interleaved without systematically burying beliefs.
  hybrid: number;
  score: number;
  // Sourced from BeliefRecord.lastReinforcedTs, not createdTs: a belief that
  // was created long ago but reinforced by fresh evidence yesterday is
  // current as of yesterday, not as of its original creation. That is the
  // right notion of "how current is this belief" for a consumer choosing
  // between competing beliefs. Named `ts` to match PackedObservation.ts.
  ts: number;
}

export interface PackedObservation {
  id: string;
  ts: number;
  source: string;
  content: string;
  score: number;
}

// The compact result handed to the assistant's prompt assembler.
export interface ContextPack {
  query: string;
  context: RecallContext;
  beliefs: PackedBelief[];
  observations: PackedObservation[];
  // A ready-to-inline rendering of the pack, within the char budget. Empty when
  // the kernel abstains (nothing cleared the score floor).
  text: string;
  // Rough token estimate of `text` (chars / 4).
  tokensEstimate: number;
  // True when no candidate cleared minScore and the pack is intentionally empty.
  abstained: boolean;
}

// An optional intent-aware selection step. The default keeps score order; an
// implementation may reorder or drop candidates based on inferred intent.
export interface Reranker {
  rerank(
    query: string,
    context: RecallContext,
    candidates: ScoredBelief[],
  ): Promise<ScoredBelief[]>;
}

export interface RecallOptions {
  now?: number;
  // Max beliefs / observations retained in the pack.
  topKBeliefs?: number;
  topKObservations?: number;
  // Blend weight: 1 = pure BM25, 0 = pure vector. Default 0.5 (hybrid).
  alpha?: number;
  // Half-life (days) of the recency factor. Distinct from per-belief decay.
  recencyHalfLifeDays?: number;
  // Abstention threshold: beliefs scoring below this are excluded, and if none
  // clear it the pack is empty (the assistant declines to guess).
  minScore?: number;
  includeObservations?: boolean;
  // Graph expansion radius over the edge table (0 disables).
  graphHops?: number;
  // Association score given to a belief pulled in only by graph expansion.
  graphBoost?: number;
  // Character budget for the rendered pack text.
  maxChars?: number;
  reranker?: Reranker;
  // Observations whose only supporting belief has been superseded are demoted
  // rather than removed: the ledger stays append-only and the evidence stays
  // reachable, but a correction outranks the statement it corrects.
  demoteSuperseded?: boolean;
  // Character budget for a single observation slot's rendered passage. 0
  // (the default) disables expansion: a slot is exactly the retrieved
  // observation, byte-identical to today. When positive, each selected
  // observation is expanded outward with same-session ledger neighbours (see
  // neighbourGapMs) up to this budget, so a slot carries a passage rather
  // than one sentence. Runs after top-k selection: it changes rendering, not
  // which observations were selected or how they rank.
  slotCharBudget?: number;
  // Max ts gap (ms) between two adjacent ledger observations for them to be
  // treated as the same session during expansion. Adapter-ingested turns
  // within a session land roughly 1s apart in ts; sessions are days apart
  // (src/eval/mem0-adapter-server.ts, OBSERVATION_TURN_OFFSET_MS), so a
  // 60s default comfortably separates the two without a session column.
  neighbourGapMs?: number;
}

const DEFAULTS = {
  topKBeliefs: 12,
  topKObservations: 3,
  alpha: 0.5,
  recencyHalfLifeDays: 90,
  minScore: 0.0,
  includeObservations: true,
  graphHops: 1,
  graphBoost: 0.25,
  maxChars: 2000,
  demoteSuperseded: false,
  slotCharBudget: 0,
  neighbourGapMs: 60_000,
} as const;

const MS_PER_DAY = 86_400_000;

// Multiplier applied to an observation whose only supporting belief has been
// superseded. Demotes rather than removes: the evidence stays reachable.
const SUPERSEDED_PENALTY = 0.5;

// A belief scope is incompatible with the context only when a dimension is
// defined on BOTH sides and the values differ. An absent context dimension does
// not exclude a scoped belief (we simply do not know it conflicts).
export function scopeCompatible(scope: Scope, context: RecallContext): boolean {
  for (const key of Object.keys(scope)) {
    const scopeVal = scope[key];
    if (scopeVal === undefined || scopeVal === null) continue;
    const ctxVal = context[key];
    if (ctxVal !== undefined && ctxVal !== scopeVal) {
      return false;
    }
  }
  return true;
}

// Reward beliefs whose scope the context actively confirms. A global (unscoped)
// belief is always fully applicable; a scoped belief whose dimensions the
// context matches scores 1.0; one whose dimensions the context leaves unknown
// scores 0.5 (applicable but less certain). Never zero, so scope never alone
// eliminates a candidate that passed the compatibility filter.
export function scopeMatchScore(scope: Scope, context: RecallContext): number {
  const dims = Object.keys(scope).filter((k) => {
    const v = scope[k];
    return v !== undefined && v !== null;
  });
  if (dims.length === 0) return 1;
  let matched = 0;
  for (const key of dims) {
    if (context[key] === scope[key]) matched++;
  }
  return 0.5 + 0.5 * (matched / dims.length);
}

// Cosine similarity of two L2-normalized vectors is their dot product. Clamped
// to [0, 1] so it composes multiplicatively in the score.
function cosine(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) {
    dot += (a[i] as number) * (b[i] as number);
  }
  return dot < 0 ? 0 : dot > 1 ? 1 : dot;
}

// Max-normalize a score map into 0..1 so BM25 (unbounded) and vector similarity
// (already 0..1) can be blended on the same scale.
function maxNormalize(scores: Map<string, number>): Map<string, number> {
  let max = 0;
  for (const v of scores.values()) if (v > max) max = v;
  if (max === 0) return scores;
  const out = new Map<string, number>();
  for (const [k, v] of scores) out.set(k, v / max);
  return out;
}

// Join separator between an anchor and each accepted neighbour. Counted once
// per neighbour added, so the running character total matches the final
// joined string length exactly regardless of which side neighbours came from.
const NEIGHBOUR_JOIN = " ";

// Expand a selected observation into a passage by walking outward through the
// ts-ordered ledger, alternating backwards and forwards from the anchor. A
// neighbour is accepted only when the ts gap to the last accepted neighbour
// on that side is under neighbourGapMs (the same-session heuristic) and only
// while accepting it keeps the joined passage within slotCharBudget; once a
// side fails either check it closes for good (later candidates on that side
// are only farther away), and the other side keeps growing until it closes
// too. The result is joined in chronological order so the anchor sits in its
// natural position rather than first.
function expandObservationContent(
  all: ObservationRecord[],
  anchorIndex: number,
  slotCharBudget: number,
  neighbourGapMs: number,
): string {
  const anchor = all[anchorIndex]!;
  const accepted = new Map<number, ObservationRecord>([[anchorIndex, anchor]]);
  let usedChars = anchor.content.length;

  let leftIdx = anchorIndex - 1;
  let rightIdx = anchorIndex + 1;
  let leftLastTs = anchor.ts;
  let rightLastTs = anchor.ts;
  let leftOpen = leftIdx >= 0;
  let rightOpen = rightIdx < all.length;
  let tryLeft = true;

  while (leftOpen || rightOpen) {
    const side =
      leftOpen && rightOpen
        ? tryLeft
          ? "left"
          : "right"
        : leftOpen
          ? "left"
          : "right";

    if (side === "left") {
      const cand = all[leftIdx]!;
      if (leftLastTs - cand.ts >= neighbourGapMs) {
        leftOpen = false;
      } else {
        const added = cand.content.length + NEIGHBOUR_JOIN.length;
        if (usedChars + added > slotCharBudget) {
          leftOpen = false;
        } else {
          accepted.set(leftIdx, cand);
          usedChars += added;
          leftLastTs = cand.ts;
          leftIdx--;
          leftOpen = leftIdx >= 0;
        }
      }
    } else {
      const cand = all[rightIdx]!;
      if (cand.ts - rightLastTs >= neighbourGapMs) {
        rightOpen = false;
      } else {
        const added = cand.content.length + NEIGHBOUR_JOIN.length;
        if (usedChars + added > slotCharBudget) {
          rightOpen = false;
        } else {
          accepted.set(rightIdx, cand);
          usedChars += added;
          rightLastTs = cand.ts;
          rightIdx++;
          rightOpen = rightIdx < all.length;
        }
      }
    }

    tryLeft = !tryLeft;
  }

  return [...accepted.keys()]
    .sort((a, b) => a - b)
    .map((i) => accepted.get(i)!.content)
    .join(NEIGHBOUR_JOIN);
}

export async function recall(
  db: DB,
  embedder: Embedder,
  query: string,
  context: RecallContext = {},
  options: RecallOptions = {},
): Promise<ContextPack> {
  const now = options.now ?? Date.now();
  const alpha = options.alpha ?? DEFAULTS.alpha;
  const topKBeliefs = options.topKBeliefs ?? DEFAULTS.topKBeliefs;
  const topKObservations =
    options.topKObservations ?? DEFAULTS.topKObservations;
  const recencyHalfLifeDays =
    options.recencyHalfLifeDays ?? DEFAULTS.recencyHalfLifeDays;
  const minScore = options.minScore ?? DEFAULTS.minScore;
  const includeObservations =
    options.includeObservations ?? DEFAULTS.includeObservations;
  const graphHops = options.graphHops ?? DEFAULTS.graphHops;
  const graphBoost = options.graphBoost ?? DEFAULTS.graphBoost;
  const maxChars = options.maxChars ?? DEFAULTS.maxChars;
  const demoteSuperseded =
    options.demoteSuperseded ?? DEFAULTS.demoteSuperseded;
  const slotCharBudget = options.slotCharBudget ?? DEFAULTS.slotCharBudget;
  const neighbourGapMs = options.neighbourGapMs ?? DEFAULTS.neighbourGapMs;

  const queryEmbedding = await embedder.embed(query);
  const recencyLambda = Math.LN2 / (recencyHalfLifeDays * MS_PER_DAY);
  const recencyOf = (belief: BeliefRecord): number =>
    Math.exp(-recencyLambda * Math.max(0, now - belief.lastReinforcedTs));

  // Step 1: scope filter over active beliefs only. Superseded/archived beliefs
  // are history, not recall candidates.
  const active = listBeliefs(db, { status: "active" });
  const compatible = active.filter((b) => scopeCompatible(b.scope, context));

  // Step 2: hybrid recall (BM25 + vector) over the scope-compatible beliefs.
  const bm25 = new Bm25Index(
    compatible.map((b) => ({
      id: b.id,
      text: canonicalBeliefText(b.kind, b.predicate, b.value),
    })),
  );
  const bm25Scores = maxNormalize(bm25.scoreAll(query));
  const compatibleById = new Map(compatible.map((b) => [b.id, b]));
  const activeById = new Map(active.map((b) => [b.id, b]));
  const hybridOf = (belief: BeliefRecord): number => {
    const bm = bm25Scores.get(belief.id) ?? 0;
    const vec = cosine(queryEmbedding, belief.embedding);
    return alpha * bm + (1 - alpha) * vec;
  };

  // Seeds are compatible beliefs with a direct query signal. A compatible
  // belief that matches nothing and is not connected to a match is irrelevant
  // and dropped here, which is what keeps recall a pack and not a dump.
  const seedIds = new Set(
    compatible.filter((b) => hybridOf(b) > 0).map((b) => b.id),
  );

  // Step 3: graph expansion. From the seeds, pull beliefs 1-2 hops out over the
  // edge table. A connected belief with no direct query match still surfaces
  // (e.g. home_airport pulled in by a flight-booking intent), marked viaGraph
  // and carrying an association score rather than a keyword/vector one.
  const viaGraph = new Set<string>();
  if (graphHops > 0 && seedIds.size > 0) {
    let frontier = new Set(seedIds);
    for (let hop = 0; hop < graphHops; hop++) {
      const next = new Set<string>();
      for (const id of frontier) {
        for (const edge of listEdges(db, { srcId: id })) next.add(edge.dstId);
        for (const edge of listEdges(db, { dstId: id })) next.add(edge.srcId);
      }
      for (const id of next) {
        if (seedIds.has(id) || viaGraph.has(id)) continue;
        const belief = activeById.get(id);
        if (!belief) continue; // edge points at an entity or non-active belief
        if (!scopeCompatible(belief.scope, context)) continue;
        viaGraph.add(id);
      }
      frontier = next;
    }
  }

  // Candidate set: direct seeds plus graph-expanded neighbors.
  const candidateIds = new Set<string>([...seedIds, ...viaGraph]);
  const candidates = [...candidateIds]
    .map((id) => compatibleById.get(id) ?? activeById.get(id))
    .filter((b): b is BeliefRecord => b !== undefined);

  // Step 4: combine into a single score per belief.
  const scored: ScoredBelief[] = candidates.map((belief) => {
    const bm = bm25Scores.get(belief.id) ?? 0;
    const vec = cosine(queryEmbedding, belief.embedding);
    const graph = viaGraph.has(belief.id);
    // Graph neighbors carry an association score so they can surface below
    // direct hits even when the query never mentions them.
    const hybrid = graph
      ? Math.max(alpha * bm + (1 - alpha) * vec, graphBoost)
      : alpha * bm + (1 - alpha) * vec;
    const eff = effectiveConfidence(belief, now);
    const rec = recencyOf(belief);
    const sm = scopeMatchScore(belief.scope, context);
    return {
      belief,
      effectiveConfidence: eff,
      bm25: bm,
      vector: vec,
      recency: rec,
      scopeMatch: sm,
      hybrid,
      score: hybrid * eff * rec * sm,
      viaGraph: graph,
    };
  });

  scored.sort(
    (a, b) => b.score - a.score || a.belief.id.localeCompare(b.belief.id),
  );

  // Step 5: intent-aware selection. Default reranker is identity (score order).
  let selected = scored.filter((s) => s.score > minScore);
  if (options.reranker) {
    selected = await options.reranker.rerank(query, context, selected);
  }
  const topBeliefs = selected.slice(0, topKBeliefs);

  // A few raw observations complement the beliefs (DESIGN.md 4.4 step 2).
  let topObservations: ScoredObservation[] = [];
  // Anchor observation id -> expanded passage content. Populated only when
  // slotCharBudget > 0; otherwise packing falls back to the observation's own
  // content, which is what keeps the feature byte-identical to today when off.
  const expandedContent = new Map<string, string>();
  if (includeObservations && topKObservations > 0) {
    // Observations that are provenance only for a superseded belief are stale:
    // demoted below their correction, never removed (the ledger is
    // append-only and superseded evidence must stay reachable). An
    // observation that also supports an active belief is not stale.
    const supersededObs = new Set<string>();
    if (demoteSuperseded) {
      for (const b of listBeliefs(db, {})) {
        if (b.status !== "superseded") continue;
        for (const obsId of getProvenanceObservationIds(db, b.id)) {
          supersededObs.add(obsId);
        }
      }
      for (const b of listBeliefs(db, {})) {
        if (b.status !== "active") continue;
        for (const obsId of getProvenanceObservationIds(db, b.id)) {
          supersededObs.delete(obsId);
        }
      }
    }

    const observations = readObservations(db, {});
    const obsBm25 = new Bm25Index(
      observations.map((o) => ({ id: o.id, text: o.content })),
    );
    const obsScores = maxNormalize(obsBm25.scoreAll(query));
    topObservations = observations
      .map((observation) => {
        const bm = obsScores.get(observation.id) ?? 0;
        const vec = cosine(queryEmbedding, observation.embedding);
        return {
          observation,
          bm25: bm,
          vector: vec,
          score: alpha * bm + (1 - alpha) * vec,
        };
      })
      // minScore gates on the unpenalised score: an observation that would
      // clear the floor on its own merit stays in the pack even when demoted.
      // The penalty affects ranking, not membership, which is what keeps
      // superseded evidence reachable rather than filtered out.
      .filter((s) => s.score > minScore)
      .map((s) =>
        supersededObs.has(s.observation.id)
          ? { ...s, score: s.score * SUPERSEDED_PENALTY }
          : s,
      )
      .sort(
        (a, b) =>
          b.score - a.score || a.observation.id.localeCompare(b.observation.id),
      )
      .slice(0, topKObservations);

    if (slotCharBudget > 0) {
      const indexById = new Map(observations.map((o, i) => [o.id, i]));
      for (const s of topObservations) {
        const anchorIndex = indexById.get(s.observation.id);
        if (anchorIndex === undefined) continue;
        expandedContent.set(
          s.observation.id,
          expandObservationContent(
            observations,
            anchorIndex,
            slotCharBudget,
            neighbourGapMs,
          ),
        );
      }
    }
  }

  const abstained = topBeliefs.length === 0 && topObservations.length === 0;

  const packedBeliefs: PackedBelief[] = topBeliefs.map((s) => ({
    id: s.belief.id,
    kind: s.belief.kind,
    predicate: s.belief.predicate,
    value: s.belief.value,
    scope: s.belief.scope,
    confidence: s.effectiveConfidence,
    hybrid: s.hybrid,
    score: s.score,
    ts: s.belief.lastReinforcedTs,
  }));
  const packedObservations: PackedObservation[] = topObservations.map((s) => ({
    id: s.observation.id,
    ts: s.observation.ts,
    source: s.observation.source,
    content: expandedContent.get(s.observation.id) ?? s.observation.content,
    score: s.score,
  }));

  const text = renderPack(packedBeliefs, packedObservations, maxChars);

  return {
    query,
    context,
    beliefs: packedBeliefs,
    observations: packedObservations,
    text,
    tokensEstimate: Math.ceil(text.length / 4),
    abstained,
  };
}

// Render the pack as compact text within a character budget. Beliefs come
// first (they are the model of the user); observations fill remaining budget.
// Lines that would overflow the budget are dropped rather than truncated.
function renderPack(
  beliefs: PackedBelief[],
  observations: PackedObservation[],
  maxChars: number,
): string {
  if (beliefs.length === 0 && observations.length === 0) return "";
  const lines: string[] = [];
  let used = 0;
  const push = (line: string): boolean => {
    const cost = line.length + 1; // newline
    if (used + cost > maxChars) return false;
    lines.push(line);
    used += cost;
    return true;
  };

  if (beliefs.length > 0) {
    if (!push("Known about the user:")) return lines.join("\n");
    for (const b of beliefs) {
      const scopeKeys = Object.keys(b.scope).filter(
        (k) => b.scope[k] !== undefined && b.scope[k] !== null,
      );
      const scopeStr =
        scopeKeys.length > 0
          ? ` (in ${scopeKeys.map((k) => `${k}=${String(b.scope[k])}`).join(", ")})`
          : "";
      const line = `- ${b.predicate}: ${b.value}${scopeStr} [${b.kind}, confidence ${b.confidence.toFixed(2)}]`;
      if (!push(line)) break;
    }
  }

  if (observations.length > 0) {
    if (push("Relevant recent context:")) {
      for (const o of observations) {
        if (!push(`- [${o.source}] ${o.content}`)) break;
      }
    }
  }

  return lines.join("\n");
}
