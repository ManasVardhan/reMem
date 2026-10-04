// Core types for the ReMem memory kernel.
//
// The two halves of the model:
//   - Observation: the immutable ledger (truth of record).
//   - Belief: the derived, mutable, confidence-scored layer (what we reason on).
//
// Phase 1 exercises Observation only. Belief/Entity/Edge types are declared here
// so the schema and later phases have a stable contract to build against.

export type Actor = "user" | "assistant" | "system";

// Known sources, but the field is intentionally open (string) so new input
// channels do not require a type change.
export type Source =
  | "slack"
  | "email"
  | "code"
  | "voice"
  | "manual"
  | (string & {});

// A snapshot of the situation an observation occurred in. Every dimension is
// optional; an absent dimension means "unspecified", not "any".
export interface ContextSnapshot {
  surface?: string; // e.g. slack, docs, terminal
  project?: string;
  device?: string;
  mode?: string; // e.g. focus, casual
  timeOfDay?: string;
  [key: string]: unknown;
}

// What a caller passes to kernel.observe(). id and embedding are assigned by the
// kernel; ts defaults to now if omitted.
export interface ObservationInput {
  // Normally assigned by the kernel. An importer supplies one so that porting
  // the same source row twice is a no-op rather than a duplicate.
  id?: string;
  ts?: number; // epoch ms
  source: Source;
  actor: Actor;
  content: string;
  contextSnapshot?: ContextSnapshot;
  meta?: Record<string, unknown>;
}

// A stored ledger row, as read back from the database.
export interface ObservationRecord {
  id: string;
  // The ledger's append position for this row. Present on rows read back,
  // absent on one just constructed. Anything resuming a pass over the ledger
  // needs it: it is the only strictly increasing key the table has.
  rowid?: number;
  ts: number;
  source: string;
  actor: Actor;
  content: string;
  embedding: Float32Array;
  contextSnapshot: ContextSnapshot;
  meta: Record<string, unknown>;
}

// --- Belief layer (declared now, exercised from Phase 2 onward) ---

export type BeliefKind =
  | "preference"
  | "fact"
  | "habit"
  | "goal"
  | "relationship";

export type BeliefStatus = "active" | "superseded" | "archived";

// The scope a belief holds within. Null/absent dimension = holds in any value of
// that dimension. Mirrors ContextSnapshot so scope-matching is a direct compare.
export interface Scope {
  surface?: string;
  project?: string;
  mode?: string;
  [key: string]: unknown;
}

export interface BeliefRecord {
  id: string;
  kind: BeliefKind;
  subject: string; // entity id the belief is about (usually the user)
  predicate: string; // e.g. writing_style, home_airport
  value: string; // e.g. concise, SFO
  confidence: number; // 0..1 stored base confidence
  scope: Scope;
  createdTs: number;
  lastReinforcedTs: number;
  decayRate: number; // lambda
  status: BeliefStatus;
  embedding: Float32Array;
}

// --- Session and episode: the readable account of the ledger ---
//
// A session is the container observations arrived in. An episode is a derived,
// structured account of one unit of work inside it. Both are bookkeeping over
// the ledger: neither is a source of truth, and both can be rebuilt from the
// observations they point at.

export type SessionStatus = "active" | "completed";

export interface SessionRecord {
  id: string;
  source: string; // claude-code, import, chat
  project?: string; // absolute path, the scope dimension
  projectName?: string; // basename, for display
  title?: string;
  startedTs: number;
  endedTs?: number;
  status: SessionStatus;
  promptCount: number;
  meta: Record<string, unknown>;
}

// The kinds mirror what a working session actually produces. Open (string &{})
// so an importer can carry a foreign vocabulary through without a type change.
export type EpisodeKind =
  | "discovery"
  | "feature"
  | "bugfix"
  | "change"
  | "decision"
  | "refactor"
  | "session"
  | (string & {});

export interface EpisodeRecord {
  id: string;
  sessionId?: string;
  project?: string;
  ts: number;
  kind: EpisodeKind;
  title: string;
  subtitle?: string;
  narrative?: string;
  facts: string[];
  concepts: string[];
  filesRead: string[];
  filesChanged: string[];
  meta: Record<string, unknown>;
}

export type EntityType = "person" | "project" | "tool" | "place" | "org";

export interface EntityRecord {
  id: string;
  type: EntityType;
  name: string;
  aliases: string[];
  attributes: Record<string, unknown>;
  embedding: Float32Array;
}

export type EdgeType =
  | "works_on"
  | "prefers"
  | "located_in"
  | "conflicts_with"
  | "supersedes"
  | "derived_from"
  | (string & {});

export interface EdgeRecord {
  srcId: string;
  dstId: string;
  type: EdgeType;
  weight: number;
  ts: number;
}
