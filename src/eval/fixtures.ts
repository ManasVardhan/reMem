import type { BeliefOp } from "../consolidate/ops.js";
import {
  FunctionConsolidator,
  type ConsolidationContext,
} from "../consolidate/consolidator.js";
import type { Scope } from "../types/index.js";
import type { EvalCase, EvalDataset } from "./types.js";

// A synthetic, labeled dataset that exercises the four ability slices the
// architecture is designed to win. It is deliberately small and deterministic:
// its job is to make the comparative story between baselines legible and
// reproducible in CI, not to stand in for LongMemEval or LoCoMo (those need
// downloads and an LLM judge; see datasets.ts).
//
// The knowledge-update case is constructed so the STALE statement is phrased
// more like the query than the current one. That is the realistic trap for
// pure similarity search: the most on-topic-looking text is the outdated fact.
// ReMem survives it via supersession; naive vector-RAG does not.

const cases: EvalCase[] = [
  {
    id: "extract-1",
    ability: "extraction",
    observations: [
      {
        id: "extract-1-o1",
        source: "chat",
        actor: "user",
        content: "For the record, my home airport is JFK.",
        ts: 1000,
      },
    ],
    query: "what is my home airport",
    context: {},
    goldObservationIds: ["extract-1-o1"],
    answerable: true,
  },
  {
    id: "update-1",
    ability: "knowledge_update",
    observations: [
      {
        id: "update-1-o1",
        source: "chat",
        actor: "user",
        content: "My home airport is SFO.",
        ts: 1000,
      },
      {
        id: "update-1-o2",
        source: "chat",
        actor: "user",
        content: "I moved to Oakland, so I fly out of OAK now.",
        ts: 2000,
      },
    ],
    query: "what is my home airport",
    context: {},
    // The CURRENT airport only. Retrieving the superseded SFO line is wrong.
    goldObservationIds: ["update-1-o2"],
    answerable: true,
  },
  {
    id: "scope-1",
    ability: "scope",
    observations: [
      {
        id: "scope-1-slack",
        source: "slack",
        actor: "user",
        content: "In Slack, keep it concise.",
        ts: 1000,
        contextSnapshot: { surface: "slack" },
      },
      {
        id: "scope-1-docs",
        source: "docs",
        actor: "user",
        content: "In the design docs, be thorough and detailed.",
        ts: 1100,
        contextSnapshot: { surface: "docs" },
      },
    ],
    query: "what writing style should I use",
    context: { surface: "slack" },
    // Under a Slack context the Slack preference is the right one.
    goldObservationIds: ["scope-1-slack"],
    answerable: true,
  },
  {
    id: "abstain-1",
    ability: "abstention",
    observations: [
      {
        id: "abstain-1-o1",
        source: "chat",
        actor: "user",
        content: "My neighbor has a golden retriever named Biscuit.",
        ts: 1000,
      },
    ],
    query: "what car do I drive",
    context: {},
    // Never stated. The right behavior is to abstain, not to guess.
    goldObservationIds: [],
    answerable: false,
  },
];

export function syntheticDataset(): EvalDataset {
  return { name: "reMem-synthetic-v1", cases };
}

// A scripted consolidator standing in for an LLM over the synthetic data. It
// emits the same typed ops a real consolidator would, driven by simple content
// rules, so the ReMem system under test consolidates deterministically and
// offline. Real runs swap in an LLM-backed Consolidator implementing the same
// interface.
const AIRPORT_RE = /\b(JFK|SFO|OAK|LAX|SEA|LGA)\b/;

function detectStyle(content: string): string | undefined {
  const lower = content.toLowerCase();
  if (lower.includes("concise")) return "concise";
  if (lower.includes("thorough")) return "thorough";
  if (lower.includes("formal")) return "formal";
  return undefined;
}

export function fixtureConsolidator(): FunctionConsolidator {
  return new FunctionConsolidator((ctx: ConsolidationContext): BeliefOp[] => {
    const ops: BeliefOp[] = [];
    for (const obs of ctx.observations) {
      const airport = AIRPORT_RE.exec(obs.content)?.[1];
      if (airport) {
        const existing = ctx.relevantBeliefs.find(
          (b) => b.predicate === "home_airport",
        );
        if (!existing) {
          ops.push({
            op: "CREATE",
            kind: "fact",
            predicate: "home_airport",
            value: airport,
            confidence: 0.8,
            evidence: [obs.id],
          });
        } else if (existing.value !== airport) {
          ops.push({
            op: "CONTRADICT",
            beliefId: existing.id,
            newValue: airport,
            evidence: [obs.id],
          });
        } else {
          ops.push({
            op: "REINFORCE",
            beliefId: existing.id,
            delta: 0.2,
            evidence: [obs.id],
          });
        }
        continue;
      }

      const style = detectStyle(obs.content);
      if (style) {
        const surface = obs.contextSnapshot?.surface;
        const scope: Scope = typeof surface === "string" ? { surface } : {};
        ops.push({
          op: "CREATE",
          kind: "preference",
          predicate: "writing_style",
          value: style,
          scope,
          confidence: 0.8,
          evidence: [obs.id],
        });
        continue;
      }

      ops.push({ op: "NOOP", reason: "no durable signal" });
    }
    return ops;
  });
}
