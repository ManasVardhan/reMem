import { openDb, type DB, type OpenOptions } from "./db/client.js";
import { HashingEmbedder, type Embedder } from "./embed/index.js";
import {
  ingestObservation,
  readObservations,
  getObservation,
  type ObservationQuery,
} from "./ingest/index.js";
import { classifyPrompt } from "./ingest/authored.js";
import {
  listBeliefs,
  getBelief,
  getProvenanceObservationIds,
  beliefsFromObservation,
  forgetBelief,
  type BeliefFilter,
} from "./beliefs/store.js";
import {
  runConsolidation,
  type ConsolidateOptions,
  type ConsolidationReport,
} from "./consolidate/index.js";
import {
  runDecay,
  withEffectiveConfidence,
  type DecayOptions,
  type DecayReport,
  type EffectiveBelief,
} from "./decay/index.js";
import {
  recall,
  type ContextPack,
  type RecallContext,
  type RecallOptions,
} from "./recall/index.js";
import { exportSnapshot, type KernelSnapshot } from "./export/index.js";
import {
  startSession,
  endSession,
  countPrompt,
  setSessionTitle,
  getSession,
  listSessions,
  listProjects,
  type StartSessionInput,
  type SessionQuery,
} from "./sessions/index.js";
import {
  putEpisode,
  getEpisode,
  listEpisodes,
  getEpisodeObservationIds,
  type EpisodeInput,
  type EpisodeQuery,
} from "./episodes/index.js";
import {
  search,
  timeline,
  type SearchQuery,
  type SearchResult,
  type TimelineOptions,
  type TimelineEntry,
} from "./search/index.js";
import type { Consolidator } from "./consolidate/consolidator.js";
import type {
  Actor,
  BeliefRecord,
  ObservationInput,
  ObservationRecord,
  SessionRecord,
  EpisodeRecord,
} from "./types/index.js";

export interface KernelOptions {
  db?: OpenOptions;
  embedder?: Embedder;
  // Who is allowed to write to the ledger.
  //
  // The ledger is the evidence base for a model of the user, so by default only
  // the user writes to it. An agent's own output is evidence about the agent:
  // consolidating it makes memory describe its own behaviour back to itself,
  // and reinforces whatever the agent already assumed. Recording it also means
  // an immutable, permanent copy of text nobody chose to say.
  //
  // Widen it only for a corpus that genuinely has several speakers, such as the
  // LoCoMo dialogues in the evaluation harness. Doing so is a deliberate act,
  // which is why it is not the default.
  ledgerActors?: Actor[];
  // Prefixes marking a prompt a routine submitted, for routines whose text
  // carries no marker of its own. See scheduledPrefixes() in mcp/store.
  scheduledPrefixes?: string[];
  // The consolidator (LLM-backed or scripted) used by consolidate(). Optional so
  // the write path and reads work without one; consolidate() throws if it is
  // called while unset.
  consolidator?: Consolidator;
}

// The result of why(): a belief and the observations that justify it.
export interface Provenance {
  belief: BeliefRecord;
  observations: ObservationRecord[];
}

// ReMemKernel wires storage, embedding, and the four processes together behind
// the small public surface from the design: observe (Phase 1),
// consolidate/beliefs/why (Phase 2), decay/forget (Phase 3), and
// recall/export (Phase 4). The full MemoryKernel interface is now implemented.
export class ReMemKernel {
  private readonly db: DB;
  private readonly embedder: Embedder;
  private readonly consolidator: Consolidator | undefined;
  private readonly ledgerActors: ReadonlySet<Actor>;
  private readonly scheduledPrefixes: string[];

  constructor(opts: KernelOptions = {}) {
    this.db = openDb(opts.db ?? {});
    this.embedder = opts.embedder ?? new HashingEmbedder();
    this.consolidator = opts.consolidator;
    this.ledgerActors = new Set(opts.ledgerActors ?? ["user"]);
    this.scheduledPrefixes = opts.scheduledPrefixes ?? [];
  }

  // --- write path ---

  // Ingest a single observation into the immutable ledger.
  //
  // Refuses anything the ledger is not for. This is checked here rather than
  // left to each caller because the ledger is append-only: a row written by
  // mistake cannot be taken back through any ordinary path, and every belief
  // derived from it inherits the mistake.
  async observe(input: ObservationInput): Promise<ObservationRecord> {
    // Blocks the harness injects into the prompt channel are not the user
    // talking, however much they look like it from here. Checked before the
    // actor, because a notification arriving with actor "user" is the exact
    // case that fills a store with beliefs about its own task ids.
    //
    // A scheduled run is not rejected: a routine's instructions say real things
    // about what the user is doing. It is recorded with its origin, so nothing
    // downstream has to call it something they said.
    const authored = classifyPrompt(input.content, this.scheduledPrefixes);
    if (authored === undefined) {
      throw new Error(
        "nothing in this observation was written by the user. " +
          "Notifications, reminders and command output are not evidence about them.",
      );
    }
    if (!this.ledgerActors.has(input.actor)) {
      throw new Error(
        `the ledger records ${[...this.ledgerActors].join(", ")}, not "${input.actor}". ` +
          `An agent's output is evidence about the agent, not about the user. ` +
          `Pass ledgerActors to KernelOptions if this store is a multi-speaker corpus.`,
      );
    }
    // Stored as authored: an injected block sitting inside a real prompt is
    // removed rather than kept alongside it.
    return ingestObservation(this.db, this.embedder, {
      ...input,
      content: authored.content,
      contextSnapshot: {
        ...(input.contextSnapshot ?? {}),
        origin: authored.origin,
      },
    });
  }

  // Convenience for bulk ingest (e.g. loading a dialogue). Preserves order.
  async observeMany(inputs: ObservationInput[]): Promise<ObservationRecord[]> {
    const out: ObservationRecord[] = [];
    for (const input of inputs) {
      out.push(await this.observe(input));
    }
    return out;
  }

  // Consolidate recent observations into beliefs. The consolidator proposes
  // typed ops; the deterministic reducer applies them.
  async consolidate(
    options: ConsolidateOptions = {},
  ): Promise<ConsolidationReport> {
    if (!this.consolidator) {
      throw new Error(
        "consolidate() requires a consolidator; pass one via KernelOptions.consolidator",
      );
    }
    return runConsolidation(this.db, this.embedder, this.consolidator, options);
  }

  // Run a decay pass: archive active beliefs that have decayed below the floor.
  // Deterministic and LLM-free.
  decay(options: DecayOptions = {}): DecayReport {
    return runDecay(this.db, options);
  }

  // --- read path ---

  // Recall a compact, ranked ContextPack for a query in the current context.
  // Scope-filters, hybrid-ranks (BM25 + vector), expands over the graph, scores
  // by semantic_sim * effective_confidence * recency * scope_match, and packs
  // within a budget. Returns an empty (abstained) pack when nothing is relevant.
  async recall(
    query: string,
    context: RecallContext = {},
    options: RecallOptions = {},
  ): Promise<ContextPack> {
    return recall(this.db, this.embedder, query, context, options);
  }

  // --- introspection / trust ---

  // Active beliefs by default; pass a filter to narrow or include other statuses.
  beliefs(filter: BeliefFilter = { status: "active" }): BeliefRecord[] {
    return listBeliefs(this.db, filter);
  }

  // Beliefs annotated with time-decayed effective confidence at `now`. This is
  // the confidence recall should rank and threshold on.
  effectiveBeliefs(
    filter: BeliefFilter = { status: "active" },
    now: number = Date.now(),
  ): EffectiveBelief[] {
    return listBeliefs(this.db, filter).map((b) =>
      withEffectiveConfidence(b, now),
    );
  }

  // Explain a belief: return it plus the observations that justify it. Throws if
  // the belief does not exist.
  why(beliefId: string): Provenance {
    const belief = getBelief(this.db, beliefId);
    if (!belief) {
      throw new Error(`unknown belief: ${beliefId}`);
    }
    const observationIds = getProvenanceObservationIds(this.db, beliefId);
    const observations: ObservationRecord[] = [];
    for (const id of observationIds) {
      const obs = getObservation(this.db, id);
      if (obs) observations.push(obs);
    }
    return { belief, observations };
  }

  // --- control ---

  // Explicit user erasure of a belief and its provenance/edges. The ledger
  // observations are untouched. Throws if the belief does not exist.
  async forget(beliefId: string): Promise<void> {
    const removed = forgetBelief(this.db, beliefId);
    if (!removed) {
      throw new Error(`unknown belief: ${beliefId}`);
    }
  }

  // Sovereignty: return a complete, JSON-serializable snapshot of the kernel
  // (ledger, beliefs, edges, provenance). The user owns their data and can take
  // it with them.
  async export(): Promise<KernelSnapshot> {
    return exportSnapshot(this.db);
  }

  // --- the readable account: sessions and episodes ---
  //
  // These are bookkeeping over the ledger, not new memory processes. The eight
  // processes from the design are unchanged; what follows only groups and
  // narrates observations that are already recorded.

  // Open or update a session. Idempotent by id: hooks fire more than once.
  session(input: StartSessionInput): SessionRecord {
    return startSession(this.db, input);
  }

  closeSession(id: string, ts: number = Date.now()): void {
    endSession(this.db, id, ts);
  }

  countPrompt(id: string): number {
    return countPrompt(this.db, id);
  }

  titleSession(id: string, title: string): void {
    setSessionTitle(this.db, id, title);
  }

  getSession(id: string): SessionRecord | undefined {
    return getSession(this.db, id);
  }

  sessions(query: SessionQuery = {}): SessionRecord[] {
    return listSessions(this.db, query);
  }

  projects(): ReturnType<typeof listProjects> {
    return listProjects(this.db);
  }

  // Record a derived account of some observations. Rewritable by id, because a
  // later pass over the same window may tell the story better.
  putEpisode(input: EpisodeInput): EpisodeRecord {
    return putEpisode(this.db, input);
  }

  episodes(query: EpisodeQuery = {}): EpisodeRecord[] {
    return listEpisodes(this.db, query);
  }

  getEpisode(id: string): EpisodeRecord | undefined {
    return getEpisode(this.db, id);
  }

  // The episode equivalent of why(): the observations an account was drawn
  // from. Same contract, so nothing derived is ever unsourced.
  whyEpisode(episodeId: string): {
    episode: EpisodeRecord;
    observations: ObservationRecord[];
  } {
    const episode = getEpisode(this.db, episodeId);
    if (!episode) {
      throw new Error(`unknown episode: ${episodeId}`);
    }
    const observations: ObservationRecord[] = [];
    for (const id of getEpisodeObservationIds(this.db, episodeId)) {
      const obs = getObservation(this.db, id);
      if (obs) observations.push(obs);
    }
    return { episode, observations };
  }

  // Which beliefs rest on one observation: why() read the other way round.
  beliefsFrom(observationId: string): BeliefRecord[] {
    return beliefsFromObservation(this.db, observationId);
  }

  // Lexical search across episodes, the ledger, and beliefs. Distinct from
  // recall(), which ranks semantically for an agent's context window; this is
  // the search box a person types into.
  search(query: SearchQuery): SearchResult {
    return search(this.db, query);
  }

  // What surrounded a moment.
  timeline(options: TimelineOptions): TimelineEntry[] {
    return timeline(this.db, options);
  }

  // --- low-level ledger reads (stable across phases) ---

  observations(query: ObservationQuery = {}): ObservationRecord[] {
    return readObservations(this.db, query);
  }

  observation(id: string): ObservationRecord | undefined {
    return getObservation(this.db, id);
  }

  // Escape hatch for tests and future phases that need direct SQL. Not part of
  // the public product surface.
  get raw(): DB {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
