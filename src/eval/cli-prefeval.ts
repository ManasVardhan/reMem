import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Embedder } from "../embed/index.js";
import { HashingEmbedder } from "../embed/index.js";
import { createTransformersEmbedder } from "../embed/transformers.js";
import type { Consolidator } from "../consolidate/consolidator.js";
import { FunctionConsolidator } from "../consolidate/consolidator.js";
import { LLMConsolidator, createOpenAICompleter } from "../consolidate/llm.js";
import {
  loadPrefEvalSamples,
  type PrefForm,
  PREF_CONSOLIDATOR_INSTRUCTIONS,
} from "./prefeval.js";
import { NaiveVectorSystem, NoMemorySystem } from "./systems.js";
import { PrecomputedSystem, buildReMemRetrievals } from "./shared-store.js";
import { runEval } from "./runner.js";
import { renderReport } from "./report.js";
import { scorePrefForSystem, type PrefScore } from "./pref-judge.js";
import type { MemorySystem } from "./types.js";

// PrefEval entry point. Assembles each preference instance into a
// preference-plus-distractors observation stream (see prefeval.ts), then scores
// two axes:
//   - offline retrieval (default): gold is the preference-bearing turn(s), so
//     recall@k / MRR / grounded top-1 answer "did memory resurface the
//     preference after N distractor turns" with no LLM calls.
//   - preference following (--judge): an answerer LLM responds to the query from
//     each system's retrieved memory, and a judge LLM classifies whether the
//     answer honors the preference. This is PrefEval's native metric and the
//     axis where the belief layer is designed to win, especially on the implicit
//     forms where no turn states the preference verbatim for naive vector to
//     retrieve.

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
  form: PrefForm;
  useHashing: boolean;
  minScore: number;
  k: number;
  useLlm: boolean;
  batch: number;
  distractorTurns: number;
  judge: boolean;
  maxInstances?: number;
  maxPerTopic?: number;
  topics?: string[];
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    form: "explicit",
    useHashing: false,
    minScore: 0.3,
    k: 5,
    useLlm: false,
    batch: 1,
    distractorTurns: 0,
    judge: false,
  };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "form" && value) opts.form = value as PrefForm;
    else if (key === "hashing") opts.useHashing = true;
    else if (key === "minScore" && value) opts.minScore = Number(value);
    else if (key === "k" && value) opts.k = Number(value);
    else if (key === "llm") opts.useLlm = true;
    else if (key === "batch" && value) opts.batch = Number(value);
    else if (key === "turns" && value) opts.distractorTurns = Number(value);
    else if (key === "judge") opts.judge = true;
    else if (key === "instances" && value) opts.maxInstances = Number(value);
    else if (key === "maxpertopic" && value) opts.maxPerTopic = Number(value);
    else if (key === "topics" && value) opts.topics = value.split(",");
  }
  return opts;
}

function nullConsolidator(): FunctionConsolidator {
  return new FunctionConsolidator(() => []);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if ((opts.useLlm || opts.judge) && !process.env.OPENAI_API_KEY) {
    throw new Error(
      "--llm and --judge require OPENAI_API_KEY (real chat-completion calls). " +
        "Drop them to run retrieval-only and offline.",
    );
  }
  const baseEmbedder = opts.useHashing
    ? new HashingEmbedder()
    : createTransformersEmbedder();
  const embedder = new MemoizingEmbedder(baseEmbedder);

  const samples = loadPrefEvalSamples({
    form: opts.form,
    distractorTurns: opts.distractorTurns,
    ...(opts.maxInstances !== undefined
      ? { maxInstances: opts.maxInstances }
      : {}),
    ...(opts.maxPerTopic !== undefined ? { maxPerTopic: opts.maxPerTopic } : {}),
    ...(opts.topics ? { topics: opts.topics } : {}),
  });
  const cases = samples.flatMap((s) => s.cases);
  const dataset = { name: `prefeval-${opts.form}`, cases };

  process.stdout.write(
    `Loaded ${cases.length} ${opts.form} preference instances ` +
      `(${opts.distractorTurns} distractor turns each)\n` +
      `Embedder: ${opts.useHashing ? "hashing" : "transformers"} (memoized), ` +
      `minScore ${opts.minScore}, k ${opts.k}, ` +
      `beliefs: ${opts.useLlm ? `LLM (batch ${opts.batch})` : "off"}\n\n`,
  );

  const reMemRecall = opts.useHashing
    ? { alpha: 1, minScore: opts.minScore }
    : { minScore: opts.minScore };

  const makeConsolidator: () => Consolidator = opts.useLlm
    ? () =>
        new LLMConsolidator({
          complete: createOpenAICompleter(),
          extraInstructions: PREF_CONSOLIDATOR_INSTRUCTIONS,
        })
    : nullConsolidator;

  // Distilled belief statements per case, captured during the build. Fed to the
  // answerer only for reMem in the judge pass, so the comparison isolates what
  // the belief layer adds over raw retrieval.
  const beliefTextByCaseId = new Map<string, string[]>();

  process.stdout.write("Building reMem belief stores...\n");
  const reMemRetrievals = await buildReMemRetrievals(samples, {
    embedder,
    makeConsolidator,
    recallOptions: reMemRecall,
    consolidateEvery: opts.batch,
    rankModes: ["beliefs-first", "observations-first", "blended"],
    onCaseBeliefs: (caseId, statements) => {
      beliefTextByCaseId.set(caseId, statements);
    },
    onSampleDone: (id, i, n) => {
      if (i === n || i % 25 === 0) {
        process.stdout.write(`  built ${i}/${n} samples (${id})\n`);
      }
    },
  });

  const reMemObs = new PrecomputedSystem(
    "reMem-obs",
    reMemRetrievals.get("observations-first")!,
  );
  const systems: MemorySystem[] = [
    new NoMemorySystem(),
    new NaiveVectorSystem(embedder),
    new PrecomputedSystem("reMem", reMemRetrievals.get("beliefs-first")!),
    reMemObs,
    new PrecomputedSystem("reMem-blend", reMemRetrievals.get("blended")!),
  ];

  const report = await runEval(dataset, systems, { k: opts.k });
  const markdown = renderReport(report);

  const date = new Date(report.generatedTs).toISOString().slice(0, 10);
  const outDir = join(
    process.cwd(),
    "eval",
    "results",
    `prefeval-${opts.form}-${date}-t${opts.distractorTurns}`,
  );
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "summary.md"), markdown, "utf8");
  writeFileSync(
    join(outDir, "report.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );

  process.stdout.write(markdown);
  process.stdout.write(`\nWrote results to ${outDir}\n`);

  // Preference-following pass (opt-in). Scores the naive-vector baseline against
  // the reMem belief-first mode: naive can only retrieve verbatim turns, while
  // reMem surfaces a consolidated preference belief, so this is where the
  // implicit forms should separate them. Two LLM calls (answer + judge) per
  // sample per scored system.
  if (opts.judge) {
    const answerer = createOpenAICompleter();
    const judge = createOpenAICompleter();
    // Judge reMem in BLENDED mode: keep the top raw preference turn alongside
    // the consolidated belief so a weak or absent belief still leaves the
    // verbatim preference for the answerer. beliefs-first alone was evicting the
    // gold turn out of top-k when no belief formed, so naive (which kept the raw
    // turn) followed while reMem violated. Offline report rows are unchanged;
    // this only affects the follow-rate pass.
    const judgeSystems: MemorySystem[] = [
      new NaiveVectorSystem(embedder),
      new PrecomputedSystem("reMem", reMemRetrievals.get("blended")!),
    ];
    process.stdout.write(
      `\nRunning preference-following judge (LLM answer + LLM judge) over ` +
        `${samples.length} instances x ${judgeSystems.length} systems...\n`,
    );
    const prefScores: PrefScore[] = [];
    for (const system of judgeSystems) {
      const score = await scorePrefForSystem(system, samples, {
        k: opts.k,
        answerer,
        judge,
        // Only reMem gets the distilled beliefs; baselines answer from raw
        // retrieved turns alone.
        ...(system.name === "reMem" ? { beliefTextByCaseId } : {}),
        onProgress: (done, total) => {
          if (done === total || done % 25 === 0) {
            process.stdout.write(`  ${system.name}: ${done}/${total} judged\n`);
          }
        },
      });
      prefScores.push(score);
      process.stdout.write(
        `  ${system.name}: follow rate ${(score.followRate * 100).toFixed(1)}% ` +
          `(follows ${score.follows} / violates ${score.violates} / ` +
          `unaware ${score.unaware} / hallucinate ${score.hallucinate})\n`,
      );
    }
    const lines = [
      "# PrefEval preference-following (LLM-judged)",
      "",
      `Form: ${opts.form}. Distractor turns: ${opts.distractorTurns}.`,
      "",
      "| System | Follow rate | Follows | Violates | Unaware | Hallucinate | Cases |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    ];
    for (const s of prefScores) {
      lines.push(
        `| ${s.system} | ${(s.followRate * 100).toFixed(1)}% | ${s.follows} | ` +
          `${s.violates} | ${s.unaware} | ${s.hallucinate} | ${s.cases} |`,
      );
    }
    const prefMarkdown = lines.join("\n") + "\n";
    writeFileSync(join(outDir, "follow-rate.md"), prefMarkdown, "utf8");
    writeFileSync(
      join(outDir, "follow-rate.json"),
      JSON.stringify(prefScores, null, 2),
      "utf8",
    );
    process.stdout.write("\n" + prefMarkdown);
    process.stdout.write(`Wrote follow rate to ${outDir}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
