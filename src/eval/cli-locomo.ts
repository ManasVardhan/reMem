import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Embedder } from "../embed/index.js";
import { HashingEmbedder } from "../embed/index.js";
import { createTransformersEmbedder } from "../embed/transformers.js";
import type { Consolidator } from "../consolidate/consolidator.js";
import { FunctionConsolidator } from "../consolidate/consolidator.js";
import { LLMConsolidator, createOpenAICompleter } from "../consolidate/llm.js";
import { loadLocomoSamples } from "./locomo.js";
import {
  FullContextSystem,
  NaiveVectorSystem,
  NoMemorySystem,
} from "./systems.js";
import { PrecomputedSystem, buildReMemRetrievals } from "./shared-store.js";
import { runEval } from "./runner.js";
import { renderReport } from "./report.js";
import { scoreQaForSystem, type QaScore } from "./qa-judge.js";
import type { EvalDataset, MemorySystem } from "./types.js";

// Real-benchmark entry point (`pnpm eval:locomo`). Loads the downloaded LoCoMo
// artifact and runs the same four systems the synthetic harness uses, but over
// real multi-session dialogues and with a real local embedder. Scoring stays
// retrieval-grounded (recall@k / MRR / abstention over dia_ids), so no LLM judge
// is involved.
//
// NOTE: no LLM-backed consolidator exists yet, so ReMem forms no beliefs here
// and its retrieval reflects the recall pipeline alone (hybrid BM25+vector +
// scope + abstention floor). That already isolates one thesis: hybrid recall
// with a confidence floor vs naive top-k vector that can never abstain. The
// belief-supersession win needs the LLM consolidator and is a separate step.

// Wraps an embedder with a text-keyed cache. LoCoMo re-runs every QA over the
// same dialogue, so the same turn texts would otherwise be re-embedded hundreds
// of times. Memoizing collapses embedding cost to the unique-text count, which
// is what makes a real transformer run finish in seconds rather than hours.
class MemoizingEmbedder implements Embedder {
  readonly dim: number;
  private readonly cache = new Map<string, Float32Array>();
  constructor(private readonly inner: Embedder) {
    this.dim = inner.dim;
  }
  async embed(text: string): Promise<Float32Array> {
    const hit = this.cache.get(text);
    if (hit) return hit;
    const vec = await this.inner.embed(text);
    this.cache.set(text, vec);
    return vec;
  }
}

interface CliOptions {
  path: string;
  maxSamples?: number;
  maxQaPerSample?: number;
  useHashing: boolean;
  minScore: number;
  k: number;
  // Form beliefs with an LLM-backed consolidator (real network calls, cost).
  // Off by default: reMem runs retrieval-only, matching the offline harness.
  useLlm: boolean;
  // Turns per consolidation pass when --llm is set. 1 (default) is per-turn,
  // required for clean supersession; larger values trade accuracy for fewer
  // LLM calls.
  batch: number;
  // Also run the standard LoCoMo QA-accuracy metric: generate an answer from
  // each system's top-k retrieved snippets and score it with an LLM judge. Real
  // network calls (two per answerable case per scored system). Off by default.
  qa: boolean;
  // Cache the built reMem retrievals to disk (eval/cache) keyed by the run
  // configuration. The first --llm run pays the ~5k-call belief build; later
  // runs with the same flags load the cache and skip straight to scoring, so a
  // QA rerun costs only the answer/judge calls. Keep --llm in the command on
  // reruns: it is a no-op on a cache hit but is part of the cache key.
  cache: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    path: join(process.cwd(), "data", "raw", "locomo10.json"),
    useHashing: false,
    minScore: 0.3,
    k: 5,
    useLlm: false,
    batch: 1,
    qa: false,
    cache: false,
  };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "path" && value) opts.path = value;
    else if (key === "samples" && value) opts.maxSamples = Number(value);
    else if (key === "maxqa" && value) opts.maxQaPerSample = Number(value);
    else if (key === "hashing") opts.useHashing = true;
    else if (key === "minScore" && value) opts.minScore = Number(value);
    else if (key === "k" && value) opts.k = Number(value);
    else if (key === "llm") opts.useLlm = true;
    else if (key === "batch" && value) opts.batch = Number(value);
    else if (key === "qa") opts.qa = true;
    else if (key === "cache") opts.cache = true;
  }
  return opts;
}

// No beliefs are wanted here (no LLM consolidator), so the consolidator is a
// no-op: it emits zero ops, leaving recall to run over the raw observations.
function nullConsolidator(): FunctionConsolidator {
  return new FunctionConsolidator(() => []);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if ((opts.useLlm || opts.qa) && !process.env.OPENAI_API_KEY) {
    throw new Error(
      "--llm and --qa require OPENAI_API_KEY (real chat-completion calls). " +
        "Set it, or drop the flag to run retrieval-only and offline.",
    );
  }
  const baseEmbedder = opts.useHashing
    ? new HashingEmbedder()
    : createTransformersEmbedder();
  const embedder = new MemoizingEmbedder(baseEmbedder);

  const samples = loadLocomoSamples(opts.path, {
    ...(opts.maxSamples !== undefined ? { maxSamples: opts.maxSamples } : {}),
    ...(opts.maxQaPerSample !== undefined
      ? { maxQaPerSample: opts.maxQaPerSample }
      : {}),
  });
  const cases = samples.flatMap((s) => s.cases);
  const dataset: EvalDataset = { name: "locomo10", cases };

  const answerable = cases.filter((c) => c.answerable).length;
  process.stdout.write(
    `Loaded ${cases.length} cases (${answerable} answerable, ` +
      `${cases.length - answerable} abstention) across ${samples.length} ` +
      `dialogues from ${opts.path}\n` +
      `Embedder: ${opts.useHashing ? "hashing" : "transformers"} (memoized), ` +
      `minScore ${opts.minScore}, k ${opts.k}, ` +
      `beliefs: ${opts.useLlm ? `LLM (batch ${opts.batch})` : "off"}\n\n`,
  );

  // Real embedder => hybrid recall with a nonzero abstention floor. With the
  // hashing stub, fall back to pure BM25 (its vector channel is noise).
  const reMemRecall = opts.useHashing
    ? { alpha: 1, minScore: opts.minScore }
    : { minScore: opts.minScore };

  // ReMem runs over a shared belief store per dialogue: ingest + consolidate
  // once, then answer every QA read-only. With --llm this is what keeps the
  // belief-forming path tractable (O(turns) LLM calls per dialogue, not
  // O(turns x QA)).
  const makeConsolidator: () => Consolidator = opts.useLlm
    ? () => new LLMConsolidator({ complete: createOpenAICompleter() })
    : nullConsolidator;
  // Score three pack-to-id orderings off the one belief store (see
  // docs/FINDINGS.md F1): the default beliefs-first plus two variants that let
  // direct observation hits reach the top-1 slot grounded accuracy scores.
  if (!opts.cache) process.stdout.write("Building reMem belief stores...\n");
  const reMemRetrievals = await buildReMemRetrievals(samples, {
    embedder,
    makeConsolidator,
    recallOptions: reMemRecall,
    consolidateEvery: opts.batch,
    rankModes: ["beliefs-first", "observations-first", "blended"],
    ...(opts.cache
      ? {
          cache: {
            dir: join(process.cwd(), "eval", "cache"),
            signature: {
              embedder: opts.useHashing ? "hashing" : "transformers",
              model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
              beliefs: opts.useLlm,
            },
          },
          onCacheStatus: (status: "hit" | "miss", file: string) =>
            process.stdout.write(
              status === "hit"
                ? `Loaded reMem retrievals from cache, skipping belief build (${file})\n`
                : "No cache for this config; building reMem belief stores...\n",
            ),
        }
      : {}),
    onSampleDone: (id, i, n) =>
      process.stdout.write(`  built ${i}/${n} dialogues (${id})\n`),
  });

  const systems: MemorySystem[] = [
    new NoMemorySystem(),
    new FullContextSystem(),
    new NaiveVectorSystem(embedder),
    new PrecomputedSystem("reMem", reMemRetrievals.get("beliefs-first")!),
    new PrecomputedSystem(
      "reMem-obs",
      reMemRetrievals.get("observations-first")!,
    ),
    new PrecomputedSystem("reMem-blend", reMemRetrievals.get("blended")!),
  ];

  const report = await runEval(dataset, systems, { k: opts.k });
  const markdown = renderReport(report);

  const date = new Date(report.generatedTs).toISOString().slice(0, 10);
  const outDir = join(process.cwd(), "eval", "results", `locomo-${date}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "summary.md"), markdown, "utf8");
  writeFileSync(
    join(outDir, "report.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );

  process.stdout.write(markdown);
  process.stdout.write(`\nWrote results to ${outDir}\n`);

  // Standard LoCoMo QA-accuracy pass (opt-in). This is the axis comparable to
  // published LoCoMo numbers. Scores only the naive-vector baseline against the
  // chosen reMem default (observations-first): each QA case costs two LLM calls
  // (answer + judge) per system, so scoring the beliefs-first and blended modes
  // too would double the spend for no new signal (their retrieval behavior is
  // already characterized by the offline metrics). no-memory and full-context
  // are excluded (nothing to answer from / not a retrieval result).
  if (opts.qa) {
    const answerer = createOpenAICompleter();
    const judge = createOpenAICompleter();
    const qaSystemNames = new Set(["naive-vector", "reMem-obs"]);
    const qaSystems = systems.filter((s) => qaSystemNames.has(s.name));
    const answerableCount = cases.filter(
      (c) => c.answerable && c.goldAnswer !== undefined,
    ).length;
    process.stdout.write(
      `\nRunning standard LoCoMo QA accuracy (LLM answer + LLM judge) over ` +
        `${answerableCount} answerable cases x ${qaSystems.length} systems...\n`,
    );
    const qaScores: QaScore[] = [];
    for (const system of qaSystems) {
      const score = await scoreQaForSystem(system, cases, {
        k: opts.k,
        answerer,
        judge,
        onProgress: (done, total) => {
          if (done === total || done % 25 === 0) {
            process.stdout.write(
              `  ${system.name}: ${done}/${total} judged\n`,
            );
          }
        },
      });
      qaScores.push(score);
      process.stdout.write(
        `  ${system.name}: QA accuracy ${(score.accuracy * 100).toFixed(1)}% ` +
          `(${score.correct}/${score.cases})\n`,
      );
    }
    const qaLines = ["# LoCoMo QA accuracy (LLM-judged)", ""];
    qaLines.push("| System | QA accuracy | Correct | Cases |");
    qaLines.push("| --- | --- | --- | --- |");
    for (const s of qaScores) {
      qaLines.push(
        `| ${s.system} | ${(s.accuracy * 100).toFixed(1)}% | ${s.correct} | ${s.cases} |`,
      );
    }
    const qaMarkdown = qaLines.join("\n") + "\n";
    writeFileSync(join(outDir, "qa-accuracy.md"), qaMarkdown, "utf8");
    writeFileSync(
      join(outDir, "qa-accuracy.json"),
      JSON.stringify(qaScores, null, 2),
      "utf8",
    );
    process.stdout.write("\n" + qaMarkdown);
    process.stdout.write(`Wrote QA accuracy to ${outDir}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
