import type { Actor, ContextSnapshot } from "../types/index.js";
import type { RecallContext } from "../recall/index.js";

// The evaluation harness (BENCHMARKS.md 6-7). It
// runs several memory systems over a labeled dataset and reports the canonical
// metrics against three baselines: no-memory, full-context stuffing, and naive
// vector-RAG. ReMem's thesis is that it approaches full-context accuracy at
// close to no-memory cost while beating naive vector on knowledge updates and
// abstention.
//
// The harness is deterministic and offline. QA "answer correctness" against
// external datasets needs an LLM judge; that slots in behind the Judge
// interface. For the synthetic set we measure retrieval-grounded metrics that
// need no model: whether the system surfaced the correct (current) supporting
// observation, and whether it abstained when it should. Those are exactly the
// memory layer's responsibilities.

// The ability slices we exercise. A subset of the external-benchmark abilities
// (BENCHMARKS.md 2, 4), chosen because they are the ones the architecture is
// designed to win: extraction, knowledge updates (supersession), scope routing,
// and abstention (confidence floor).
export type Ability =
  | "extraction"
  | "knowledge_update"
  | "scope"
  | "abstention"
  // Preference following (PrefEval): the gold observation is a durable
  // preference stated far upstream of a topically-adjacent query. Surfacing it
  // is the belief layer's job, not episodic recall.
  | "preference";

export interface EvalObservation {
  id: string;
  source: string;
  actor: Actor;
  content: string;
  ts: number;
  contextSnapshot?: ContextSnapshot;
}

export interface EvalCase {
  id: string;
  ability: Ability;
  // The conversation / event history this case reasons over.
  observations: EvalObservation[];
  query: string;
  context: RecallContext;
  // Observations that justify the correct answer. For a knowledge-update case
  // this is the CURRENT observation only, not the superseded one.
  goldObservationIds: string[];
  // The reference answer text, used only by the model-judged QA-accuracy metric
  // (the standard LoCoMo score). Undefined for abstention cases, which have no
  // gold answer.
  goldAnswer?: string;
  // False for the abstention slice: there is no answer in the history.
  answerable: boolean;
}

export interface EvalDataset {
  name: string;
  cases: EvalCase[];
}

// What a system returns for one case. Ranked observation ids drive the
// retrieval metrics; abstain and contextTokens drive trust and cost.
export interface Retrieval {
  // Observation ids the system surfaced, best-first (mapped back to the eval
  // dataset's ids even if the system stored them under its own).
  rankedObservationIds: string[];
  // Estimated tokens the answering model would receive (chars / 4).
  contextTokens: number;
  // The system declares nothing is relevant. ReMem does this via its
  // confidence floor; naive vector-RAG cannot and always returns its top-k.
  abstain: boolean;
}

// A memory system under test. Each case is isolated (systems do not carry state
// between cases) so results are order-independent and reproducible.
export interface MemorySystem {
  readonly name: string;
  retrieve(evalCase: EvalCase): Promise<Retrieval>;
}
