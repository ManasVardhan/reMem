# ReMem: Memory Kernel Design

> ReMem (n.): the physical trace a memory leaves in the brain. This project is
> the substrate that lets a personal AI assistant form, revise, and recall an
> evolving model of a single user.

## 1. Problem statement

We are building the memory layer for a JARVIS-class personal assistant. The moat
of such an assistant is not the model (rented, commoditizing) or the UI
(copyable). It is the **accumulated, structured understanding of one user** that
compounds with every interaction. The kernel owns that understanding.

Most "AI memory" systems today are a thin wrapper over a vector store: embed
everything, retrieve by cosine similarity, stuff into the prompt. That yields a
search engine over transcripts, not a model of a person. It cannot answer:

- "What does the user _currently_ prefer?" (preferences change)
- "Why do you believe that?" (no provenance)
- "Is this true in Slack but not in docs?" (no context scoping)
- "Should I even have an opinion here?" (no confidence / abstention)

ReMem is designed around those four gaps.

## 2. The one big idea: ledger vs. beliefs

Separate the **immutable ledger** from the **mutable belief layer**.

- **Ledger** - append-only, never edited. Every observation (a message, an
  email, a code event, a voice note) is written once with its source, timestamp,
  and a snapshot of the context it occurred in. This is truth-of-record. It is
  re-derivable and auditable.
- **Beliefs** - derived, mutable, confidence-scored, context-scoped, decaying.
  This is what the assistant actually reasons over. Beliefs are _consolidated_
  from the ledger and always point back to the observations that justify them.

Almost every failure mode of existing systems comes from collapsing these two
into a single mutable store. Keeping them apart is what makes conflict
resolution, decay, forgetting, provenance, and recomputation tractable.

```
             ingest                consolidate               recall
  sources ───────────▶  LEDGER  ───────────────▶  BELIEFS  ─────────▶ context pack
  (raw, immutable)     (append-only)   (LLM +      (mutable,     (scoped, ranked,
                                        reducer)   provenance)    compact)
                                          ▲             │
                                          └──── decay / forget (deterministic)
```

## 3. Data model

Storage is a single embedded database (SQLite / libSQL). "Graph" is just an
edges table; we do not need Neo4j. Vectors live in the same DB via `sqlite-vec`.

### 3.1 observation (immutable ledger)

| column           | type    | notes                                              |
| ---------------- | ------- | -------------------------------------------------- |
| id               | text pk | uuid                                               |
| ts               | int     | epoch ms                                           |
| source           | text    | slack \| email \| code \| voice \| manual \| ...   |
| actor            | text    | user \| assistant \| system                        |
| content          | text    | raw text/event                                     |
| embedding        | blob    | vector for raw-event recall                        |
| context_snapshot | json    | {surface, project, device, mode, time_of_day, ...} |
| meta             | json    | source-specific fields (thread id, url, ...)       |

Never updated. Never deleted (except by explicit user erasure / GDPR).

### 3.2 belief (derived, mutable)

| column             | type    | notes                                                |
| ------------------ | ------- | ---------------------------------------------------- |
| id                 | text pk | uuid                                                 |
| kind               | text    | preference \| fact \| habit \| goal \| relationship  |
| subject            | text    | entity id the belief is about (usually the user)     |
| predicate          | text    | e.g. `writing_style`, `home_airport`                 |
| value              | text    | e.g. `concise`, `SFO`                                |
| confidence         | real    | 0..1 (stored base confidence)                        |
| scope              | json    | {surface?, project?, mode?, ...} nullable dims = any |
| created_ts         | int     |                                                      |
| last_reinforced_ts | int     | for decay                                            |
| decay_rate         | real    | lambda; per-kind default, tunable                    |
| status             | text    | active \| superseded \| archived                     |
| embedding          | blob    | vector of the canonicalized belief text              |

### 3.3 entity

Nouns in the user's life: `person | project | tool | place | org`. Columns:
`id, type, name, aliases[], attributes{}, embedding`.

### 3.4 edge (the graph)

`src_id, dst_id, type, weight, ts`. Edge types include:
`works_on, prefers, located_in, conflicts_with, supersedes, derived_from`.

### 3.5 provenance

`belief_id -> observation_id[]`. Every belief points to the observations that
justify it. This enables three things nobody else ships:

1. **`why(beliefId)`** - the assistant can always explain itself.
2. **Auditability** - you can inspect and correct the model of the user.
3. **Recomputation** - when consolidation logic improves, re-derive beliefs from
   the ledger without re-collecting data.

### 3.5.1 What may enter the ledger

Only what the user said. The ledger is the evidence base for a model of the
user, and three kinds of text look like a prompt without being one:

1. **The agent's replies.** Produced from memory, so recording them feeds
   memory its own output.
2. **The agent's tool calls.** Evidence about the agent's behaviour, not the
   person's.
3. **Harness injections.** Task notifications, system reminders, command
   output, the text a scheduled run submits. Written by nobody.

Measured on a real store, the third category alone was 27% of rows, and had
produced confident beliefs about task ids and output paths.

`observe()` rejects all three. It is enforced there rather than at each call
site because the ledger is append-only: a mistaken row is permanent, and every
belief derived from it inherits the mistake. A corpus with real multiple
speakers opts in through `ledgerActors`, which is a deliberate act by design.

### 3.6 session and episode (derived, readable)

The ledger is the truth and the belief layer is what we reason on, but neither
is what a person reads when they ask "what did we do last week". Two derived
layers sit between them, and neither is a source of truth.

**session**: which observations arrived together, in what project, and whether
it is still running. Bookkeeping. Delete every row and the ledger is unchanged;
what is lost is only the ability to say "these arrived together".

**episode**: a structured account of one unit of work, in the shape a person
wants to read back: kind, title, subtitle, narrative, facts, concepts, and the
files read and changed. Derived, so it may be rewritten when a later pass tells
the story better, and like a belief it must resolve to the observations behind
it. `whyEpisode(id)` is `why(id)` for accounts.

Episodes are derived **once per session**, in the same pass that produces
beliefs. The alternative, summarising every tool call as it happens, costs a
model call per message and is what makes other memory layers expensive to run.
Which files were touched is not asked for at all: the ledger already knows, so
it is computed from the rows.

Both layers are rebuildable from the ledger. That is the test of whether
something belongs here rather than in the ledger: if losing it would lose
information, it is in the wrong place.

## 4. The four processes

### 4.1 Ingest (cheap, synchronous, no LLM)

Normalize any input into an `observation`, capture the current
`context_snapshot`, embed, append. Fast and lossless. No reasoning here - that is
deliberately deferred to consolidation so ingestion never blocks the assistant.

### 4.2 Consolidate (LLM, async, batched)

The heart of the system. A consolidator reads a window of recent observations
plus the currently-relevant beliefs and emits a strict, typed list of
**belief ops**. It never mutates the store directly; a deterministic reducer
applies the ops with confidence gating. This keeps the LLM's role testable,
cheap, and safe.

```
CREATE(kind, predicate, value, scope, confidence, evidence[])
REINFORCE(belief_id, delta, evidence[])        // evidence agrees -> bump conf, refresh ts
CONTRADICT(belief_id, new_value, scope, evidence[])
                                               // creates new belief + `supersedes` edge;
                                               // old belief is NOT deleted, only superseded
REFINE(belief_id, narrower_scope, evidence[])  // "concise" -> "concise in slack"
NOOP(reason)                                   // observation carries no durable signal
```

Reducer rules (deterministic):

- `CREATE` inserts a belief only if confidence >= `create_floor` (e.g. 0.35),
  else it is dropped (avoids belief spam from one-off remarks).
- `REINFORCE` bumps `confidence = 1 - (1 - c) * (1 - delta)` (saturating toward
  1), refreshes `last_reinforced_ts`, appends provenance.
- `CONTRADICT` inserts the new belief, marks the old `status = superseded`,
  writes a `supersedes` edge. Retrieval prefers the newest non-superseded belief
  within a matching scope.
- `REFINE` narrows scope and, if the broad belief no longer has independent
  support, supersedes it.

Model choice: a cheap, fast model (Claude Haiku / Sonnet, or any Bedrock model -
the kernel is provider-agnostic). Consolidation is batched and off the hot path,
so latency is not user-facing.

### 4.3 Decay + forget (deterministic, scheduled)

Confidence is time-discounted on read (and compacted on a timer):

```
effective_confidence = base_confidence * exp(-decay_rate * (now - last_reinforced_ts))
```

- Per-kind decay rates: identity `fact`s decay glacially; ephemeral
  `preference`s decay fast; `goal`s decay on their own horizon.
- Below a floor, a belief flips to `status = archived` (soft delete). The ledger
  still holds the evidence, so nothing is truly lost and forgetting is
  reversible.
- **Forgetting is a feature**, not a bug: it keeps retrieval sharp and the model
  current, and it is what makes "I liked X in March, hate it now" behave
  correctly without manual cleanup.

### 4.4 Recall (read path, intent-aware, not just semantic)

Given a `query` and the current `context`:

```
1. scope filter    - keep beliefs whose scope is compatible with current context
2. hybrid recall   - BM25 + vector over beliefs AND a few raw observations
3. graph expansion - pull connected entities/relations (1–2 hops)
4. score           - semantic_sim * effective_confidence * recency * scope_match
5. select          - small reranker/LLM keeps what is relevant to the INTENT
6. pack            - return a compact "context pack", not a dump
```

Two non-obvious choices, both validated by the benchmark literature:

- **Hybrid BM25 + vector** (step 2). Keyword search with stemming is
  surprisingly strong on conversational data (BM25 alone hits ~86% on
  LongMemEval QA; BM25+vector ~95%). Pure vector search underperforms here.
- **Intent-aware selection** (step 5). The right memory for "book my flight" is
  the user's seat preference and home airport, which are _not_ the
  semantically-nearest chunks to that sentence. Selection conditions on inferred
  intent, not surface tokens.

## 5. Public API (kernel surface)

Deliberately tiny. Everything else is a client of this.

```ts
interface MemoryKernel {
  // write path
  observe(input: Observation): Promise<void>;
  consolidate(opts?: { since?: number }): Promise<ConsolidationReport>;
  decay(): Promise<DecayReport>;

  // read path
  recall(
    query: string,
    context: Context,
    opts?: RecallOpts,
  ): Promise<ContextPack>;

  // introspection / trust
  why(beliefId: string): Promise<Provenance>;
  beliefs(filter?: BeliefFilter): Promise<Belief[]>;

  // control
  forget(beliefId: string): Promise<void>; // explicit user erasure
  export(): Promise<KernelSnapshot>; // sovereignty: user owns their data
}
```

Reading back what happened is bookkeeping over that surface, not a fifth
process. These group and narrate observations that are already recorded, and
add no way for anything to enter memory:

```ts
sessions(query?): SessionRecord[];
episodes(query?): EpisodeRecord[];
whyEpisode(id): { episode; observations };   // provenance, for accounts
search(query): SearchResult;                 // lexical, over all three layers
timeline(opts): TimelineEntry[];             // what surrounded a moment
beliefsFrom(observationId): BeliefRecord[];  // why(), read backwards
```

`search` is not `recall`. `recall` ranks semantically, packs a context window
for an agent, and abstains when nothing fits. `search` is the box a person types
into: it returns what matched, in an index cheap enough to page through before
fetching anything in full.

**Consolidation is incremental.** It resumes from a cursor into the ledger's
append order (rowid), not a timestamp and not an id: observations share
milliseconds, and ids are random, so either of those silently drops rows at a
tie. Without a cursor at all, every session end re-reads the whole ledger, which
makes the system slowest for the people who have used it most.

## 6. Design principles (non-negotiable)

1. **Ledger is sacred.** Append-only, re-derivable, exportable. The user owns it.
2. **The LLM proposes, the reducer disposes.** No unbounded LLM mutation of state.
3. **Every belief has provenance.** If we cannot say why, we do not store it.
4. **Confidence and scope are first-class**, not metadata afterthoughts. This is
   what makes recall feel tailored and enables abstention ("I don't know").
5. **Forgetting is designed**, not accidental.
6. **Local-first, sovereign.** The model of the user can live entirely on the
   user's machine (local embeddings + local DB). Sync is optional and
   user-controlled. This is a product stance and a moat, not an implementation
   detail.
7. **Provider-agnostic.** Swap embedding and consolidation models freely.

## 7. What is novel vs. mem0 / vector-RAG memory

| capability                          | vector-RAG | mem0 | ReMem |
| ----------------------------------- | :--------: | :--: | :---: |
| semantic recall                     |     ✅     |  ✅  |  ✅   |
| fact extraction / add-update        |     ⚠️     |  ✅  |  ✅   |
| immutable ledger + provenance       |     ❌     |  ❌  |  ✅   |
| confidence scoring                  |     ❌     |  ❌  |  ✅   |
| time decay + designed forgetting    |     ❌     |  ⚠️  |  ✅   |
| context-scoped beliefs              |     ❌     |  ❌  |  ✅   |
| supersession (conflict) graph       |     ❌     |  ⚠️  |  ✅   |
| intent-aware retrieval              |     ❌     |  ⚠️  |  ✅   |
| abstention (knowing you don't know) |     ❌     |  ❌  |  ✅   |

Pragmatic stance: borrow mem0's fact-extraction prompt patterns where useful,
but own the belief / confidence / decay / scope / provenance layer ourselves.
That layer is the moat; we do not wrap it in someone else's abstractions.

## 8. Tech stack

- **TypeScript.** Single stack across the assistant surfaces (e.g. a personal assistant).
- **libSQL / SQLite** as the single source of truth; `sqlite-vec` for vectors;
  a plain `edge` table for the graph. No separate vector DB, no graph DB.
- **Local-first with optional sync** (libSQL/Turso embedded replica).
- **Pluggable embeddings** - default to a local model (Transformers.js) so the
  model of the user never has to leave the device; allow API models for speed.
- **Pluggable consolidator LLM** - Bedrock / Anthropic / OpenAI / local.

## 9. Open questions (tracked, not blocking)

- Optimal consolidation window + trigger (every N observations vs. idle vs.
  session-boundary).
- Learned vs. fixed decay rates per belief kind.
- Cross-belief consistency checks (detecting latent contradictions the
  consolidator missed).
- Multi-user / shared-context beliefs (household, team) - v2 territory.
