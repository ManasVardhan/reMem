import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReMemKernel } from "../kernel.js";
import type { Embedder } from "../embed/index.js";
import type { Consolidator } from "../consolidate/consolidator.js";
import type { RecallOptions } from "../recall/index.js";
import { canonicalBeliefText } from "../beliefs/store.js";
import { rankPackToEvalIds } from "./systems.js";
import type { RankMode } from "./systems.js";
import type { LocomoEvalSample } from "./locomo.js";
import type { EvalCase, MemorySystem, Retrieval } from "./types.js";

// A memory system that just replays retrievals computed ahead of time. The
// generic runner (evaluateSystem) still drives it case-by-case and computes the
// same metrics; the expensive work (ingest + LLM consolidation) already happened
// once per dialogue in buildReMemRetrievals, not once per QA.
export class PrecomputedSystem implements MemorySystem {
  constructor(
    readonly name: string,
    private readonly byCaseId: Map<string, Retrieval>,
  ) {}

  async retrieve(evalCase: EvalCase): Promise<Retrieval> {
    const hit = this.byCaseId.get(evalCase.id);
    if (!hit) {
      throw new Error(`no precomputed retrieval for case ${evalCase.id}`);
    }
    return hit;
  }
}

export interface BuildReMemOptions {
  embedder: Embedder;
  // A fresh consolidator per dialogue. Pass an LLM-backed one to form beliefs;
  // a no-op one reproduces the retrieval-only pipeline (no beliefs).
  makeConsolidator: () => Consolidator;
  // Recall options per query (hybrid + minScore for a real embedder run).
  recallOptions?: RecallOptions;
  // Turns per consolidation pass. 1 (default) is per-turn, which is what makes
  // supersession fire cleanly: a stale fact commits before the turn that
  // contradicts it, so the next pass sees it as a relevant belief to supersede.
  // Larger batches are cheaper (fewer LLM calls) but a stale and its current
  // value can land in the same pass and both survive as duplicates.
  consolidateEvery?: number;
  // Pack-to-id orderings to score. Each is derived from the SAME belief store
  // and recall pack, so comparing them costs no extra ingest or LLM calls.
  // Defaults to just beliefs-first.
  rankModes?: RankMode[];
  // Optional progress hook: called after each dialogue with 1-based index.
  onSampleDone?: (sampleId: string, index: number, total: number) => void;
  // Optional hook receiving, per case, the canonical text of the beliefs in the
  // recalled pack (the distilled statements, not their provenance turns). This
  // is what lets a downstream judge feed the answerer the consolidated
  // preference itself rather than the raw turn it was derived from, which is the
  // whole point of the belief layer on PrefEval. Called once per case,
  // independent of rank mode (beliefs are pack-level).
  onCaseBeliefs?: (caseId: string, statements: string[]) => void;
  // Optional on-disk cache for the built retrievals. When set, the first build
  // writes the full rank-mode retrieval map to disk keyed by a signature of the
  // inputs that determine it (dataset, batch, recall, modes, plus the caller's
  // extra signature for embedder + model identity). Later runs with the same
  // signature load it and skip every ingest and LLM consolidation call, going
  // straight to scoring. The QA/answer/judge calls are not cached; only the
  // expensive belief-build-and-recall stage is.
  cache?: ReMemCacheOptions;
  // Called once with whether the cache was hit or missed (and the resolved
  // file path), so a CLI can report "loaded from cache" vs "building".
  onCacheStatus?: (status: "hit" | "miss", file: string) => void;
}

export interface ReMemCacheOptions {
  // Directory to hold cache files (created if missing).
  dir: string;
  // Extra fields folded into the cache key beyond what the build derives itself
  // (embedder identity, LLM model, beliefs on/off). Two runs collide only when
  // every derived input AND every signature field match.
  signature: Record<string, string | number | boolean>;
}

// Flatten the nested Map result into plain JSON for disk storage.
function serializeByMode(
  byMode: Map<RankMode, Map<string, Retrieval>>,
): Record<string, Record<string, Retrieval>> {
  const out: Record<string, Record<string, Retrieval>> = {};
  for (const [mode, inner] of byMode) {
    const obj: Record<string, Retrieval> = {};
    for (const [id, retrieval] of inner) obj[id] = retrieval;
    out[mode] = obj;
  }
  return out;
}

// Rebuild the nested Map result from the flattened JSON form.
function deserializeByMode(
  raw: Record<string, Record<string, Retrieval>>,
): Map<RankMode, Map<string, Retrieval>> {
  const byMode = new Map<RankMode, Map<string, Retrieval>>();
  for (const [mode, obj] of Object.entries(raw)) {
    const inner = new Map<string, Retrieval>();
    for (const [id, retrieval] of Object.entries(obj)) inner.set(id, retrieval);
    byMode.set(mode as RankMode, inner);
  }
  return byMode;
}

// A stable fingerprint of the dataset: sample ids plus every observation and
// case id in order. Any change to which dialogues/turns/questions are loaded
// changes this, so a stale cache is never reused across a different dataset.
function samplesSignature(samples: LocomoEvalSample[]): string {
  const hash = createHash("sha256");
  for (const sample of samples) {
    hash.update(sample.sampleId);
    hash.update(String(sample.observations.length));
    for (const obs of sample.observations) hash.update(obs.id);
    hash.update(String(sample.cases.length));
    for (const evalCase of sample.cases) hash.update(evalCase.id);
  }
  return hash.digest("hex").slice(0, 16);
}

// Resolve the cache file path for one build from all inputs that affect the
// retrievals: dataset fingerprint, batch size, recall options, rank modes, and
// the caller's extra signature (embedder + model + beliefs flag).
function cacheFilePath(
  samples: LocomoEvalSample[],
  consolidateEvery: number,
  recallOptions: RecallOptions,
  rankModes: RankMode[],
  cache: ReMemCacheOptions,
): string {
  const payload = JSON.stringify({
    samples: samplesSignature(samples),
    batch: consolidateEvery,
    recall: recallOptions,
    modes: [...rankModes].sort(),
    signature: cache.signature,
  });
  const key = createHash("sha256").update(payload).digest("hex").slice(0, 24);
  return join(cache.dir, `reMem-retrievals-${key}.json`);
}

// Build every reMem retrieval for a grouped LoCoMo dataset using ONE shared
// belief store per dialogue. For each sample: ingest all observations in time
// order, consolidate along the way (building/superseding beliefs once), then run
// each QA as a read-only recall against that store. This is what makes an
// LLM-backed consolidator tractable: consolidation cost is O(turns per dialogue)
// rather than O(turns x QA), i.e. thousands of calls instead of ~a million.
export async function buildReMemRetrievals(
  samples: LocomoEvalSample[],
  options: BuildReMemOptions,
): Promise<Map<RankMode, Map<string, Retrieval>>> {
  const consolidateEvery = Math.max(1, options.consolidateEvery ?? 1);
  const recallOptions = options.recallOptions ?? {};
  const rankModes = options.rankModes ?? ["beliefs-first"];

  // Cache hit: the belief build and recall for this exact configuration already
  // ran, so replay the stored retrievals and skip every LLM call.
  const cacheFile = options.cache
    ? cacheFilePath(
        samples,
        consolidateEvery,
        recallOptions,
        rankModes,
        options.cache,
      )
    : undefined;
  if (cacheFile && existsSync(cacheFile)) {
    const raw = JSON.parse(readFileSync(cacheFile, "utf8")) as Record<
      string,
      Record<string, Retrieval>
    >;
    options.onCacheStatus?.("hit", cacheFile);
    return deserializeByMode(raw);
  }
  if (cacheFile) options.onCacheStatus?.("miss", cacheFile);

  const byMode = new Map<RankMode, Map<string, Retrieval>>(
    rankModes.map((mode) => [mode, new Map<string, Retrieval>()]),
  );

  let index = 0;
  for (const sample of samples) {
    index += 1;
    const kernel = new ReMemKernel({
      // LoCoMo and PrefEval are dialogues between two people. The ledger is
      // user-only by default because an agent's output is not evidence about
      // the user; a corpus of real speakers is the exception, and saying so
      // here is the deliberate act that default is meant to force.
      ledgerActors: ["user", "assistant", "system"],
      embedder: options.embedder,
      consolidator: options.makeConsolidator(),
    });
    try {
      const ordered = [...sample.observations].sort((a, b) => a.ts - b.ts);
      const kernelToEval = new Map<string, string>();
      let maxTs = 0;
      let pendingSince: number | undefined;
      let sinceCount = 0;

      for (const obs of ordered) {
        const input: Parameters<ReMemKernel["observe"]>[0] = {
          source: obs.source,
          actor: obs.actor,
          content: obs.content,
          ts: obs.ts,
        };
        if (obs.contextSnapshot) input.contextSnapshot = obs.contextSnapshot;
        const record = await kernel.observe(input);
        kernelToEval.set(record.id, obs.id);
        if (obs.ts > maxTs) maxTs = obs.ts;

        if (pendingSince === undefined) pendingSince = obs.ts;
        sinceCount += 1;
        if (sinceCount >= consolidateEvery) {
          await kernel.consolidate({ since: pendingSince, now: obs.ts });
          pendingSince = undefined;
          sinceCount = 0;
        }
      }
      // Flush any tail of observations that did not fill a full batch.
      if (pendingSince !== undefined) {
        await kernel.consolidate({ since: pendingSince, now: maxTs });
      }

      for (const evalCase of sample.cases) {
        const pack = await kernel.recall(evalCase.query, evalCase.context, {
          now: maxTs,
          ...recallOptions,
        });
        if (options.onCaseBeliefs) {
          options.onCaseBeliefs(
            evalCase.id,
            pack.beliefs.map((b) =>
              canonicalBeliefText(b.kind, b.predicate, b.value),
            ),
          );
        }
        // One pack, several orderings: the expensive work is done, so scoring
        // every rank mode is free.
        for (const mode of rankModes) {
          byMode.get(mode)!.set(evalCase.id, {
            rankedObservationIds: rankPackToEvalIds(
              kernel,
              pack,
              kernelToEval,
              mode,
            ),
            contextTokens: pack.tokensEstimate,
            abstain: pack.abstained,
          });
        }
      }
    } finally {
      kernel.close();
    }
    options.onSampleDone?.(sample.sampleId, index, samples.length);
  }

  // Persist the freshly built retrievals so the next identical run is a hit.
  if (cacheFile && options.cache) {
    mkdirSync(options.cache.dir, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(serializeByMode(byMode)), "utf8");
  }

  return byMode;
}
