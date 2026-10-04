import type { BeliefRecord, ObservationRecord } from "../types/index.js";
import type { BeliefOp } from "./ops.js";

// What a consolidator sees: a window of recent observations plus the beliefs
// currently deemed relevant. It returns proposed ops. It never touches the
// store. Real implementations wrap an LLM; the returned ops are validated and
// applied by the reducer.
export interface ConsolidationContext {
  observations: ObservationRecord[];
  relevantBeliefs: BeliefRecord[];
}

export interface Consolidator {
  propose(ctx: ConsolidationContext): Promise<BeliefOp[]>;
}

// A consolidator whose behavior is supplied as a plain function. This is how the
// LLM's role is tested without a live model: feed a function that returns canned
// ops for a given context, and assert the reducer's resulting state. The real
// LLM-backed consolidator implements the same interface.
export class FunctionConsolidator implements Consolidator {
  constructor(
    private readonly fn: (
      ctx: ConsolidationContext,
    ) => BeliefOp[] | Promise<BeliefOp[]>,
  ) {}

  async propose(ctx: ConsolidationContext): Promise<BeliefOp[]> {
    return this.fn(ctx);
  }
}
