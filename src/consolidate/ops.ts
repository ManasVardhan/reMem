import { z } from "zod";

// Belief ops: the only vocabulary the consolidator LLM may emit. The LLM
// proposes these; the deterministic reducer disposes. Keeping the op set small,
// typed, and strictly validated is what makes the LLM's role testable and safe:
// it can never mutate the store directly, only request a bounded, legal change.

const beliefKind = z.enum([
  "preference",
  "fact",
  "habit",
  "goal",
  "relationship",
]);

const scope = z.record(z.unknown());
const evidence = z.array(z.string()).default([]);
const unit = z.number().min(0).max(1);

// CREATE a new belief. Gated by the reducer's create_floor so one-off remarks do
// not spawn beliefs.
export const createOpSchema = z.object({
  op: z.literal("CREATE"),
  kind: beliefKind,
  subject: z.string().optional(),
  predicate: z.string().min(1),
  value: z.string().min(1),
  scope: scope.optional(),
  confidence: unit,
  evidence,
});

// REINFORCE an existing belief: evidence agrees, so bump confidence toward 1 and
// refresh the reinforcement timestamp.
export const reinforceOpSchema = z.object({
  op: z.literal("REINFORCE"),
  beliefId: z.string().min(1),
  delta: unit,
  evidence,
});

// CONTRADICT an existing belief: the value changed. Creates a new belief and
// supersedes the old one (never deletes it).
export const contradictOpSchema = z.object({
  op: z.literal("CONTRADICT"),
  beliefId: z.string().min(1),
  newValue: z.string().min(1),
  scope: scope.optional(),
  confidence: unit.optional(),
  evidence,
});

// REFINE an existing belief: narrow its scope (e.g. "concise" becomes "concise
// in slack").
export const refineOpSchema = z.object({
  op: z.literal("REFINE"),
  beliefId: z.string().min(1),
  narrowerScope: scope,
  evidence,
});

// NOOP: the observation window carries no durable signal.
export const noopOpSchema = z.object({
  op: z.literal("NOOP"),
  reason: z.string().default(""),
});

export const beliefOpSchema = z.discriminatedUnion("op", [
  createOpSchema,
  reinforceOpSchema,
  contradictOpSchema,
  refineOpSchema,
  noopOpSchema,
]);

export type CreateOp = z.infer<typeof createOpSchema>;
export type ReinforceOp = z.infer<typeof reinforceOpSchema>;
export type ContradictOp = z.infer<typeof contradictOpSchema>;
export type RefineOp = z.infer<typeof refineOpSchema>;
export type NoopOp = z.infer<typeof noopOpSchema>;
export type BeliefOp = z.infer<typeof beliefOpSchema>;

// Parse a batch of possibly-malformed ops (e.g. raw LLM output). Invalid ops are
// dropped, not thrown, so one bad op does not sink an otherwise good batch. The
// count of rejected ops is returned for observability.
export function parseOps(raw: unknown[]): {
  ops: BeliefOp[];
  rejected: number;
} {
  const ops: BeliefOp[] = [];
  let rejected = 0;
  for (const candidate of raw) {
    const result = beliefOpSchema.safeParse(candidate);
    if (result.success) {
      ops.push(result.data);
    } else {
      rejected++;
    }
  }
  return { ops, rejected };
}
