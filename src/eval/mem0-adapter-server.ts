import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { ReMemKernel } from "../kernel.js";
import type { Embedder } from "../embed/index.js";
import { HashingEmbedder } from "../embed/index.js";
import { createTransformersEmbedder } from "../embed/transformers.js";
import type { Consolidator } from "../consolidate/consolidator.js";
import { FunctionConsolidator } from "../consolidate/consolidator.js";
import { LLMConsolidator, createOpenAICompleter } from "../consolidate/llm.js";
import type { ContextPack } from "../recall/index.js";
import type { Actor, BeliefStatus } from "../types/index.js";

// mem0-OSS-compatible HTTP adapter for the ReMemKernel.
//
// The mem0ai/memory-benchmarks harness (LoCoMo / LongMemEval / BEAM) is backend
// agnostic: in "oss" mode it drives any memory system over three REST endpoints
// (POST /memories, POST /search, DELETE /memories). Every system it scores runs
// through the *same* answerer, judge, prompts, and top-k cutoffs, so pointing
// the harness at this server puts ReMem on exactly the ground mem0 publishes
// its own numbers on. Run mem0's docker server and this server under the same
// harness invocation and the two columns are directly comparable.
//
// The kernel is single-tenant; LoCoMo uses one user_id per conversation, so we
// keep one kernel per user_id (isolated in-memory DBs, one shared embedder).

type RankMode = "beliefs-first" | "observations-first" | "blended" | "quota";

interface UserState {
  kernel: ReMemKernel;
  // Newest observed timestamp, used as recall `now` so recency decay is anchored
  // to conversation time rather than wall-clock.
  maxTs: number;
  // Every turn in a POST /memories session arrives with the identical harness
  // timestamp (LoCoMo sends one timestamp per session, not per turn), and
  // readObservations' tiebreak on equal ts is a random UUID (src/ingest/index.ts:125),
  // so same-session turns have no stable order once they hit the ledger.
  // sessionBaseTs/sessionTurnCount assign each turn a distinct, increasing ts
  // within its session (see the /memories handler) so ingest order survives.
  sessionBaseTs: number | null;
  sessionTurnCount: number;
  // Observation id -> the raw (un-offset) session timestamp it was ingested
  // under. Windowing (flattenPack) uses this to group same-session
  // observations back together even though their individual ts now differ.
  sessionOf: Map<string, number>;
}

// Per-turn ts offset within a session (Part 1 of the ordering fix). LoCoMo
// sessions are days apart and the largest session has 663 turns, so a
// 1-second-per-turn offset drifts at most ~11 minutes from the session's
// base timestamp, two orders of magnitude clear of any neighbouring
// session's timestamp. Distinct, monotonically increasing per-turn ts is
// enough on its own to fix ledger ordering (ORDER BY ts ASC, id ASC no
// longer needs the random-UUID tiebreak); the offset does not need to be
// exact wall-clock time, only ordered and safely inside its session.
const OBSERVATION_TURN_OFFSET_MS = 1000;

interface Config {
  port: number;
  embedder: "transformers" | "hashing";
  consolidator: "llm" | "null";
  rankMode: RankMode;
  minScore: number;
  beliefQuota: number;
  alpha: number;
  window: number;
  demoteSuperseded: boolean;
  slotCharBudget: number;
}

export function readConfig(): Config {
  const rank = (process.env.REMEM_RANK ?? "observations-first") as RankMode;
  return {
    port: Number(process.env.PORT ?? 8888),
    embedder: process.env.REMEM_EMBEDDER === "hashing" ? "hashing" : "transformers",
    consolidator: process.env.REMEM_CONSOLIDATOR === "llm" ? "llm" : "null",
    rankMode: rank,
    minScore: process.env.REMEM_MIN_SCORE ? Number(process.env.REMEM_MIN_SCORE) : 0.3,
    beliefQuota: process.env.REMEM_BELIEF_QUOTA
      ? Number(process.env.REMEM_BELIEF_QUOTA)
      : 10,
    alpha: process.env.REMEM_ALPHA ? Number(process.env.REMEM_ALPHA) : 0.3,
    window: process.env.REMEM_WINDOW ? Number(process.env.REMEM_WINDOW) : 0,
    // Off by default: existing and prior benchmark runs are unaffected unless
    // this is explicitly enabled.
    demoteSuperseded:
      process.env.REMEM_DEMOTE_SUPERSEDED === "true" ||
      process.env.REMEM_DEMOTE_SUPERSEDED === "1",
    // 0 (default) keeps observation slots exactly as retrieved, matching
    // prior runs unless a run explicitly opts into expansion.
    slotCharBudget: process.env.REMEM_SLOT_CHARS
      ? Number(process.env.REMEM_SLOT_CHARS)
      : 0,
  };
}

// The mem0 search contract is {id, memory, score}. The harness reads only those
// three fields, so the abstention signals below are added purely additively:
//   - confidence:     time-decayed effective confidence of the belief (0..1).
//                     This is PackedBelief.confidence, which recall() sets to the
//                     effective (decayed) confidence at recall time.
//   - evidence_count: number of provenance observations behind the belief, via
//                     kernel.why(id).observations.length.
//   - status:         belief supersession state ("active" | "superseded" |
//                     "archived"), via kernel.why(id).belief.status.
// Observations carry none of these (no confidence, provenance, or supersession
// state), so the three fields are null for observation-derived results, keeping
// the result shape uniform.
//   - created_at:     ISO-8601 timestamp the LoCoMo harness sorts and renders
//                     results by (benchmarks/locomo/prompts.py). Observations
//                     set this from their own `ts`, the ledger event time, not
//                     wall-clock or ingest time. Beliefs set this from
//                     PackedBelief.ts (the belief's lastReinforcedTs), since a
//                     belief that changes over time still needs an ordering
//                     signal: without it, a consumer choosing between two
//                     competing beliefs has no way to prefer the newer one.
interface SearchResult {
  id: string;
  memory: string;
  score: number;
  confidence: number | null;
  evidence_count: number | null;
  status: BeliefStatus | null;
  created_at: string | null;
}

// Per-query abstention signal summary, computed over the returned results. A
// downstream abstention gate thresholds on these rather than re-deriving them:
//   - max_score:         highest score across all returned results.
//   - max_confidence:    highest belief confidence across results, or null when
//                        no belief was returned (observation-only pack).
//   - top_evidence_count: evidence_count of the top-ranked (first) result, or
//                        null when that result is an observation.
//   - top_status:        status of the top-ranked (first) result, or null when
//                        that result is an observation.
interface Signals {
  max_score: number | null;
  max_confidence: number | null;
  top_evidence_count: number | null;
  top_status: BeliefStatus | null;
}

// Drop later duplicates by surface text, keeping the first (highest-ranked)
// occurrence. Used for beliefs only: two beliefs that render the same
// "predicate: value" text genuinely are redundant. Quota mode dedupes the
// belief list with this before slicing, so a run of duplicate belief text
// does not burn window slots on repeats that the cross-list collision check
// below would only discover after the belief tail had already been sliced
// too short.
function dedupeByMemory(items: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const item of items) {
    if (seen.has(item.memory)) continue;
    seen.add(item.memory);
    out.push(item);
  }
  return out;
}

// Drop later duplicates by observation id, keeping the first (highest-ranked)
// occurrence. Observations must never be deduped by rendered text: two
// distinct anchors are two distinct results even when slot expansion
// (slotCharBudget) renders overlapping or byte-identical passages for them.
// Text-keyed dedup here would silently collapse those into one slot and
// shrink the window below `limit`, which is the defect this replaces.
function dedupeById(items: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

// Flatten a recalled pack into the mem0 search contract ({id, memory, score}),
// honoring the rank mode. Beliefs render as their canonical predicate/value
// statement; observations render as raw content, undated. Beliefs are
// deduped by surface text (against each other and against observations) so a
// fact reachable via both a belief and its provenance observation counts
// once; observations are deduped by id only, so distinct anchors whose
// rendered passages happen to coincide (e.g. under slot expansion) both
// survive. Each belief result additionally carries the abstention signals
// documented on SearchResult; the kernel is used to look up provenance count
// and status. Both beliefs and observations carry created_at, as ISO-8601,
// so the harness can sort and date them itself: observations from their
// ledger ts, beliefs from their lastReinforcedTs (PackedBelief.ts).
//
// window > 0 renders each observation's slot with up to `window` same-session
// neighbours on each side joined into the memory text, instead of just the
// anchor turn. One 138-character turn per slot covers 2.4 percent of a
// 419-turn conversation at top-10, and offline probes measured windowing
// moving multi-hop ANY@50 from 79 to 93. created_at still comes from the
// anchor observation's own ts, and the memory text carries no date prefix
// (dating lives on created_at, per Task 6); windowing only changes which
// observations' content is joined into the text.
//
// Grouping key: same-session observations no longer share a literal ts (the
// /memories handler now assigns each turn a distinct, increasing ts within
// its session, so the ledger's ORDER BY ts ASC, id ASC reflects dialogue
// order instead of a random-UUID tiebreak). `sessionOf` maps an observation
// id back to the session's base timestamp it was ingested under, so a
// session is still one bucket. When `sessionOf` is absent or has no entry
// for an observation (e.g. a caller that never went through the adapter's
// ingest path, as in tests), the key falls back to the observation's own
// ts, which reproduces the exact-ts grouping this replaces. Within a
// bucket, observations are ordered by ts ascending, not id: id is an
// opaque, randomly generated UUID and carries no dialogue-order signal.
export function flattenPack(
  pack: ContextPack,
  mode: RankMode,
  limit: number,
  kernel: ReMemKernel,
  beliefQuota = 0,
  window = 0,
  sessionOf?: ReadonlyMap<string, number>,
): SearchResult[] {
  const sessionKey = (o: (typeof pack.observations)[number]): number =>
    sessionOf?.get(o.id) ?? o.ts;

  const bySession = new Map<number, typeof pack.observations>();
  if (window > 0) {
    for (const o of pack.observations) {
      const key = sessionKey(o);
      const bucket = bySession.get(key);
      if (bucket) bucket.push(o);
      else bySession.set(key, [o]);
    }
    for (const bucket of bySession.values()) {
      bucket.sort((a, b) => a.ts - b.ts);
    }
  }

  const renderWindowed = (o: (typeof pack.observations)[number]): string => {
    if (window <= 0) return o.content;
    const bucket = bySession.get(sessionKey(o));
    if (!bucket) return o.content;
    const idx = bucket.findIndex((x) => x.id === o.id);
    if (idx < 0) return o.content;
    const lo = Math.max(0, idx - window);
    const hi = Math.min(bucket.length, idx + window + 1);
    return bucket
      .slice(lo, hi)
      .map((x) => x.content)
      .join(" ");
  };

  const beliefs: SearchResult[] = pack.beliefs.map((b) => {
    // why() throws only on an unknown belief id; a recalled belief always
    // exists, but guard defensively so a lookup miss degrades to null signals
    // rather than failing the whole search.
    let evidenceCount: number | null = null;
    let status: BeliefStatus | null = null;
    try {
      const prov = kernel.why(b.id);
      evidenceCount = prov.observations.length;
      status = prov.belief.status;
    } catch {
      evidenceCount = null;
      status = null;
    }
    return {
      id: b.id,
      memory: `${b.predicate}: ${b.value}`,
      score: mode === "blended" ? b.hybrid : b.score,
      confidence: b.confidence,
      evidence_count: evidenceCount,
      status,
      // The belief's lastReinforcedTs, not createdTs: how recently it was
      // last supported by evidence, which is the right notion of "current"
      // for a consumer ordering competing beliefs.
      created_at: new Date(b.ts).toISOString(),
    };
  });
  const observations: SearchResult[] = pack.observations.map((o) => ({
    id: o.id,
    memory: renderWindowed(o),
    score: o.score,
    confidence: null,
    evidence_count: null,
    status: null,
    // The LoCoMo harness sorts results by created_at and dates its own
    // prompt lines from it; without this every result read "(unknown date)"
    // and the harness's chronological sort was a no-op. Use the ledger
    // event time (o.ts), not wall-clock or ingest time.
    created_at: new Date(o.ts).toISOString(),
  }));

  let ordered: SearchResult[];
  if (mode === "quota") {
    // Reserve the tail of the window for beliefs so they are guaranteed to be
    // inside any cutoff above (limit - quota), without displacing the head of
    // the observation ranking. Under-filled quotas give their slots back to
    // observations rather than padding.
    //
    // Dedup before slicing, not after: the final cross-list check below only
    // sees an already limit-sized array, so a run of literal duplicate
    // belief text sliced into `reserved` would burn window slots on repeats.
    // Observations are deduped by id, not text (see dedupeById): two
    // distinct anchors are two distinct results even when their expanded
    // passages overlap or match exactly.
    const dedupedObservations = dedupeById(observations);
    const dedupedBeliefs = dedupeByMemory(beliefs);
    // A belief whose memory text already appears among the observations adds
    // nothing (the final cross-list dedup would drop it anyway) but would
    // otherwise inflate `reserved` and cost the window a slot with no
    // backfill. Exclude those belief/observation collisions before sizing
    // the quota, so the reserved tail is honest and the freed slot goes back
    // to observations.
    const observationMemories = new Set(
      dedupedObservations.map((o) => o.memory),
    );
    const eligibleBeliefs = dedupedBeliefs.filter(
      (b) => !observationMemories.has(b.memory),
    );
    const reserved = Math.min(beliefQuota, eligibleBeliefs.length);
    const obsSlots = Math.max(0, limit - reserved);
    ordered = [
      ...dedupedObservations.slice(0, obsSlots),
      ...eligibleBeliefs.slice(0, reserved),
    ];
  } else if (mode === "observations-first") {
    ordered = [...observations, ...beliefs];
  } else if (mode === "blended") {
    // Beliefs are compared on their pre-attenuation hybrid so the two score
    // scales are commensurate. See Task 2.
    ordered = [...beliefs, ...observations].sort((a, b) => b.score - a.score);
  } else {
    ordered = [...beliefs, ...observations];
  }

  // Observations are deduped by id (never by text, so two distinct anchors
  // whose expanded passages happen to render the same string both survive).
  // Beliefs are deduped by text against everything already kept, which is
  // what makes a belief drop when its "predicate: value" collides with an
  // observation's content: the observation's memory is recorded into
  // seenMemory below even though it is never itself checked against it.
  //
  // Discriminated by confidence, not created_at: both lists now carry
  // created_at (beliefs are dated too, per Task 6), but confidence is still
  // belief-only, set unconditionally in the belief map above and always null
  // for observations.
  const seenIds = new Set<string>();
  const seenMemory = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of ordered) {
    const isObservation = r.confidence === null;
    if (isObservation) {
      if (seenIds.has(r.id)) continue;
      seenIds.add(r.id);
      seenMemory.add(r.memory);
    } else {
      if (seenMemory.has(r.memory)) continue;
      seenMemory.add(r.memory);
    }
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

// Summarize the abstention signals over a flattened result list. "max" fields
// aggregate across all results; "top" fields read the highest-ranked (first)
// result, which is the one the answerer weights most. Empty results yield all
// nulls.
function summarizeSignals(results: SearchResult[]): Signals {
  if (results.length === 0) {
    return {
      max_score: null,
      max_confidence: null,
      top_evidence_count: null,
      top_status: null,
    };
  }
  let maxScore = -Infinity;
  let maxConfidence: number | null = null;
  for (const r of results) {
    if (r.score > maxScore) maxScore = r.score;
    if (r.confidence !== null) {
      maxConfidence = maxConfidence === null ? r.confidence : Math.max(maxConfidence, r.confidence);
    }
  }
  const top = results[0];
  return {
    max_score: maxScore,
    max_confidence: maxConfidence,
    top_evidence_count: top?.evidence_count ?? null,
    top_status: top?.status ?? null,
  };
}

function makeEmbedder(cfg: Config): Embedder {
  return cfg.embedder === "hashing" ? new HashingEmbedder() : createTransformersEmbedder();
}

function makeConsolidatorFactory(cfg: Config): () => Consolidator {
  if (cfg.consolidator === "llm") {
    const complete = createOpenAICompleter();
    return () => new LLMConsolidator({ complete });
  }
  // Null consolidator: no beliefs form, recall runs over raw observations only
  // (hybrid BM25+vector + scope + abstention floor). This is the offline,
  // retrieval-only ReMem config; flip REMEM_CONSOLIDATOR=llm for the belief
  // layer that matches the paper's ReMem.
  return () => new FunctionConsolidator(() => []);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

async function main(): Promise<void> {
  const cfg = readConfig();
  const embedder = makeEmbedder(cfg);
  const makeConsolidator = makeConsolidatorFactory(cfg);
  const users = new Map<string, UserState>();

  function getUser(userId: string): UserState {
    let u = users.get(userId);
    if (!u) {
      const kernel = new ReMemKernel({
        db: { path: ":memory:" },
        embedder,
        consolidator: makeConsolidator(),
      });
      u = {
        kernel,
        maxTs: 0,
        sessionBaseTs: null,
        sessionTurnCount: 0,
        sessionOf: new Map(),
      };
      users.set(userId, u);
    }
    return u;
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname;

        if (req.method === "GET" && path === "/health") {
          return sendJson(res, 200, { status: "ok", config: cfg, users: users.size });
        }

        // POST /memories { messages: [{role, content}], user_id, timestamp? }
        if (req.method === "POST" && path === "/memories") {
          const body = (await readBody(req)) as {
            messages?: { role?: string; content?: string }[];
            user_id?: string;
            timestamp?: number;
          };
          const userId = body.user_id ?? "default";
          const u = getUser(userId);
          const rawTsMs =
            typeof body.timestamp === "number" ? body.timestamp * 1000 : Date.now();
          // A new session (a distinct harness timestamp) resets the per-turn
          // offset counter. Repeated POSTs carrying the same timestamp (a
          // session's turns split across multiple calls) keep counting from
          // where the previous batch left off, so arrival order across POSTs
          // to the same session is preserved too.
          if (u.sessionBaseTs !== rawTsMs) {
            u.sessionBaseTs = rawTsMs;
            u.sessionTurnCount = 0;
          }
          const results: { id: string; memory: string; event: string }[] = [];
          const batchTs: number[] = [];
          for (const m of body.messages ?? []) {
            const content = m.content ?? "";
            if (!content.trim()) continue;
            const actor: Actor = m.role === "assistant" ? "assistant" : "user";
            const turnTs =
              u.sessionBaseTs + u.sessionTurnCount * OBSERVATION_TURN_OFFSET_MS;
            u.sessionTurnCount += 1;
            const rec = await u.kernel.observe({
              source: "manual",
              actor,
              content,
              ts: turnTs,
            });
            u.sessionOf.set(rec.id, u.sessionBaseTs);
            batchTs.push(turnTs);
            results.push({ id: rec.id, memory: rec.content, event: "ADD" });
          }
          if (batchTs.length > 0) {
            u.maxTs = Math.max(u.maxTs, ...batchTs);
          }
          // Per-turn consolidation (batch 1), matching the paper's LoCoMo config.
          // since/now span this batch's assigned turn timestamps; an empty
          // batch falls back to the (unmodified) session timestamp, matching
          // the previous single-ts behaviour.
          const since =
            batchTs.length > 0 ? Math.min(...batchTs) : u.sessionBaseTs;
          const now =
            batchTs.length > 0 ? Math.max(...batchTs) : u.sessionBaseTs;
          await u.kernel.consolidate({ since, now });
          return sendJson(res, 200, { results });
        }

        // POST /search { query, user_id, limit }
        if (req.method === "POST" && path === "/search") {
          const body = (await readBody(req)) as {
            query?: string;
            user_id?: string;
            limit?: number;
          };
          const userId = body.user_id ?? "default";
          const u = users.get(userId);
          const limit = typeof body.limit === "number" ? body.limit : 200;
          if (!u)
            return sendJson(res, 200, {
              results: [],
              signals: summarizeSignals([]),
            });
          const pack = await u.kernel.recall(
            body.query ?? "",
            {},
            {
              now: u.maxTs || Date.now(),
              topKBeliefs: limit,
              topKObservations: limit,
              minScore: cfg.minScore,
              alpha: cfg.alpha,
              includeObservations: true,
              demoteSuperseded: cfg.demoteSuperseded,
              slotCharBudget: cfg.slotCharBudget,
            },
          );
          const results = flattenPack(
            pack,
            cfg.rankMode,
            limit,
            u.kernel,
            cfg.beliefQuota,
            cfg.window,
            u.sessionOf,
          );
          const signals = summarizeSignals(results);
          return sendJson(res, 200, { results, signals });
        }

        // DELETE /memories?user_id=...
        if (req.method === "DELETE" && path === "/memories") {
          const userId = url.searchParams.get("user_id") ?? "default";
          const u = users.get(userId);
          if (u) {
            u.kernel.close();
            users.delete(userId);
          }
          return sendJson(res, 200, { message: "deleted", user_id: userId });
        }

        return sendJson(res, 404, { error: "not found", path });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return sendJson(res, 500, { error: message });
      }
    })();
  });

  server.listen(cfg.port, () => {
    process.stdout.write(
      `ReMem mem0-adapter listening on :${cfg.port} ` +
        `(embedder=${cfg.embedder}, consolidator=${cfg.consolidator}, ` +
        `rank=${cfg.rankMode}, minScore=${cfg.minScore})\n`,
    );
  });
}

// Only start the server when this file is run directly (e.g. `pnpm
// serve:mem0-adapter`), not when it is imported for its exports. Without this
// gate, importing flattenPack for a test would bind the port as a side effect
// of module load.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  });
}
