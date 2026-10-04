import { homedir, platform } from "node:os";
import { join } from "node:path";
import { ReMemKernel } from "../kernel.js";
import type { Embedder } from "../embed/index.js";
import type { Consolidator } from "../consolidate/consolidator.js";
import type { ConsolidationReport } from "../consolidate/reducer.js";
import type { DecayReport } from "../decay/index.js";
import type {
  ContextPack,
  RecallContext,
  RecallOptions,
} from "../recall/index.js";
import type {
  Actor,
  ContextSnapshot,
  ObservationRecord,
  Source,
} from "../types/index.js";

// The integration layer. The kernel exposes the
// full memory surface, but an assistant only ever needs two hooks in its message
// loop:
//
//   1. record(turn)      on every conversational turn  -> observe (+ consolidate)
//   2. contextBlock(...)  during prompt assembly        -> recall, ready to inject
//
// MemoryService wraps ReMemKernel with a local-first default (a SQLite file and
// the bundled embedder), buffers observations, and auto-consolidates so callers
// never have to schedule the write path themselves. It is deliberately framework
// agnostic: any assistant host drives it through the same two methods (see
// the mapping note on ConversationTurn), so there is no per-host adapter to keep
// in sync.

// One turn in a conversation, in host-neutral shape. A chat app's message hook
// or a personal assistant's event maps onto this: role -> actor, text ->
// content, the channel and project onto the context snapshot. Non-durable
// roles (e.g. tool chatter) can simply not be recorded.
export interface ConversationTurn {
  actor: Actor;
  content: string;
  // Epoch ms. Defaults to now.
  ts?: number;
  // Where this turn happened (slack, terminal, docs, ...). Feeds both the
  // ledger source and, unless overridden, the context surface.
  source?: Source;
  // The situation, used for scoping beliefs and for scope-aware recall.
  context?: ContextSnapshot;
  meta?: Record<string, unknown>;
}

export interface MemoryServiceOptions {
  // Absolute path to the SQLite file. Omit for an ephemeral in-memory store
  // (tests, throwaway sessions). Production hosts pass a persistent path, e.g.
  // defaultDbPath().
  path?: string;
  // Pluggable embedder. Defaults to the bundled dependency-free HashingEmbedder.
  // Swap in a local transformer embedder for production-quality recall.
  embedder?: Embedder;
  // The consolidator that turns observations into beliefs. Without one the write
  // path still records to the ledger, but no beliefs form and recall falls back
  // to raw observations. Production passes an LLM-backed consolidator.
  consolidator?: Consolidator;
  // Auto-consolidate once this many observations have been recorded since the
  // last consolidation. Set to 0 to disable auto-consolidation (drive it
  // manually with flush()). Ignored when no consolidator is configured.
  consolidateEvery?: number;
  // Defaults merged into every contextBlock/recall call (e.g. maxChars, alpha).
  recallDefaults?: RecallOptions;
  // Default source for turns that omit one.
  defaultSource?: Source;
  // Which speakers the ledger records. The user alone by default: what the
  // assistant says is produced from memory, not evidence for it, and recording
  // it puts an immutable copy of text nobody chose to say into a permanent
  // store. Widen it only for a genuine multi-speaker corpus.
  ledgerActors?: Actor[];
}

// What contextBlock returns: the injectable text plus enough structure for the
// caller to decide how to use it (or to skip injection entirely on abstention).
export interface MemoryContext {
  // Ready-to-inject text. Empty string when the kernel abstained.
  text: string;
  // True when nothing relevant was known; the caller should inject nothing and
  // let the model answer without fabricated memory.
  abstained: boolean;
  // Rough token cost of `text`.
  tokensEstimate: number;
  // The full pack, for callers that want to render their own block.
  pack: ContextPack;
}

const DEFAULT_CONSOLIDATE_EVERY = 8;

// An OS-appropriate per-user data directory for the local-first store. Does not
// create anything; the caller passes the returned path to MemoryService, which
// opens (and thus creates) the file. Honors XDG_DATA_HOME on Linux.
export function defaultDataDir(appName = "reMem"): string {
  const home = homedir();
  if (platform() === "darwin") {
    return join(home, "Library", "Application Support", appName);
  }
  if (platform() === "win32") {
    return join(
      process.env.APPDATA ?? join(home, "AppData", "Roaming"),
      appName,
    );
  }
  const xdg = process.env.XDG_DATA_HOME;
  return join(
    xdg && xdg.length > 0 ? xdg : join(home, ".local", "share"),
    appName,
  );
}

// Convenience: the default SQLite file path under the data dir.
export function defaultDbPath(appName = "reMem"): string {
  return join(defaultDataDir(appName), "memory.db");
}

export class MemoryService {
  private readonly kernel: ReMemKernel;
  private readonly consolidateEvery: number;
  private readonly recallDefaults: RecallOptions;
  private readonly defaultSource: Source;
  private readonly ledgerActors: ReadonlySet<Actor>;
  private readonly canConsolidate: boolean;
  // ts of the earliest observation not yet folded into beliefs, so a triggered
  // consolidation only reprocesses the new tail.
  private pendingSince: number | undefined;
  private pendingCount = 0;

  constructor(options: MemoryServiceOptions = {}) {
    this.kernel = new ReMemKernel({
      ...(options.ledgerActors ? { ledgerActors: options.ledgerActors } : {}),
      db: options.path !== undefined ? { path: options.path } : {},
      ...(options.embedder ? { embedder: options.embedder } : {}),
      ...(options.consolidator ? { consolidator: options.consolidator } : {}),
    });
    this.canConsolidate = options.consolidator !== undefined;
    this.consolidateEvery =
      options.consolidateEvery ?? DEFAULT_CONSOLIDATE_EVERY;
    this.recallDefaults = options.recallDefaults ?? {};
    this.defaultSource = options.defaultSource ?? "manual";
    this.ledgerActors = new Set(options.ledgerActors ?? ["user"]);
  }

  // Whether a turn by this actor belongs in the ledger. The default is the
  // user alone: what the assistant said is a product of the memory, not
  // evidence for it.
  records(actor: Actor): boolean {
    return this.ledgerActors.has(actor);
  }

  // Hook 1: record a conversational turn into the ledger. Buffers toward
  // auto-consolidation; when the buffer reaches consolidateEvery the belief
  // layer is refreshed. Safe to call on every turn, including the assistant's:
  // turns the ledger does not record are skipped rather than rejected, so a
  // host can hand over the whole conversation without filtering it first.
  //
  // Returns the stored observation, or undefined for a turn that was skipped.
  async record(turn: ConversationTurn): Promise<ObservationRecord | undefined> {
    if (!this.records(turn.actor)) return undefined;

    const observation = await this.kernel.observe({
      actor: turn.actor,
      content: turn.content,
      source: turn.source ?? this.defaultSource,
      ...(turn.ts !== undefined ? { ts: turn.ts } : {}),
      ...(turn.context ? { contextSnapshot: turn.context } : {}),
      ...(turn.meta ? { meta: turn.meta } : {}),
    });

    if (this.pendingSince === undefined || observation.ts < this.pendingSince) {
      this.pendingSince = observation.ts;
    }
    this.pendingCount += 1;

    if (
      this.canConsolidate &&
      this.consolidateEvery > 0 &&
      this.pendingCount >= this.consolidateEvery
    ) {
      await this.flush();
    }

    return observation;
  }

  // Fold any buffered observations into beliefs now. No-op when nothing is
  // pending or no consolidator is configured. Call before a session ends so the
  // last few turns are not stranded below the auto-consolidation threshold.
  async flush(): Promise<ConsolidationReport | undefined> {
    if (!this.canConsolidate || this.pendingCount === 0) return undefined;
    const since = this.pendingSince;
    this.pendingSince = undefined;
    this.pendingCount = 0;
    return this.kernel.consolidate(since !== undefined ? { since } : {});
  }

  // Hook 2: build the memory block for the current query and situation. Recall
  // scope-filters, ranks, and packs within a budget, or abstains. Merges the
  // service-level recallDefaults with any per-call overrides.
  async contextBlock(
    query: string,
    context: RecallContext = {},
    options: RecallOptions = {},
  ): Promise<MemoryContext> {
    const pack = await this.kernel.recall(query, context, {
      ...this.recallDefaults,
      ...options,
    });
    return {
      text: pack.text,
      abstained: pack.abstained,
      tokensEstimate: pack.tokensEstimate,
      pack,
    };
  }

  // Run a decay pass (archive beliefs that have decayed below the floor).
  // Deterministic; a host can call this on a timer or at session boundaries.
  decay(): DecayReport {
    return this.kernel.decay();
  }

  // Escape hatch to the full kernel surface (why/beliefs/forget/export) for
  // hosts that expose memory introspection or user data controls.
  get reMem(): ReMemKernel {
    return this.kernel;
  }

  close(): void {
    this.kernel.close();
  }
}

// Local-first factory. Equivalent to `new MemoryService(options)`; the named
// export reads clearly at call sites and is the documented entry point for
// hosts.
export function createMemoryService(
  options: MemoryServiceOptions = {},
): MemoryService {
  return new MemoryService(options);
}
