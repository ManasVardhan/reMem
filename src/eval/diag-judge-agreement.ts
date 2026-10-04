import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Embedder } from "../embed/index.js";
import { createTransformersEmbedder } from "../embed/transformers.js";
import type { Consolidator } from "../consolidate/consolidator.js";
import { LLMConsolidator, createOpenAICompleter } from "../consolidate/llm.js";
import {
  loadPrefEvalSamples,
  type PrefForm,
  PREF_CONSOLIDATOR_INSTRUCTIONS,
} from "./prefeval.js";
import { NaiveVectorSystem } from "./systems.js";
import { PrecomputedSystem, buildReMemRetrievals } from "./shared-store.js";
import {
  contextSnippets,
  generateAnswer,
  judgeLabel,
} from "./pref-judge.js";
import type { MemorySystem } from "./types.js";

// F3-b: preempt the self-judging critique. The F3 follow-rate sweep used one
// model (gpt-4o-mini) as BOTH answerer and judge, so a skeptic could argue the
// judge simply rubber-stamps its own family's answers. This harness settles
// that by generating each answer ONCE (answerer fixed to the primary model),
// then grading that identical answer with two judges: the primary judge and a
// second judge from a different vendor. Because both judges score the exact
// same text, any change in follow rate or in the reMem-vs-naive gap is pure
// judge disagreement, with zero answer variance to confound it. If the gap
// survives under a different-vendor judge, the F3 claim does not depend on the
// answerer grading itself.

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
  turns: number;
  instances: number;
  k: number;
  batch: number;
  judgeModel: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    form: "choice-based",
    turns: 50,
    instances: 40,
    k: 5,
    batch: 1,
    judgeModel: "google/gemini-2.0-flash-001",
  };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "form" && value) opts.form = value as PrefForm;
    else if (key === "turns" && value) opts.turns = Number(value);
    else if (key === "instances" && value) opts.instances = Number(value);
    else if (key === "k" && value) opts.k = Number(value);
    else if (key === "batch" && value) opts.batch = Number(value);
    else if (key === "judgeModel" && value) opts.judgeModel = value;
  }
  return opts;
}

interface SystemAgreement {
  system: string;
  cases: number;
  followA: number;
  followB: number;
  followRateA: number;
  followRateB: number;
  // Fraction of answers both judges gave the identical 4-way label.
  labelAgreement: number;
  // Fraction of answers both judges agreed on the binary follows/not-follows.
  followAgreement: number;
  // Cohen's kappa on the binary follows/not-follows decision.
  kappa: number;
}

function cohensKappa(bothFollow: number, aOnly: number, bOnly: number, neither: number): number {
  const n = bothFollow + aOnly + bOnly + neither;
  if (n === 0) return 0;
  const po = (bothFollow + neither) / n;
  const aFollow = (bothFollow + aOnly) / n;
  const bFollow = (bothFollow + bOnly) / n;
  const pe = aFollow * bFollow + (1 - aFollow) * (1 - bFollow);
  if (pe === 1) return 1;
  return (po - pe) / (1 - pe);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("this diagnostic makes real LLM calls; set OPENAI_API_KEY");
  }
  const primaryModel = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  if (opts.judgeModel === primaryModel) {
    throw new Error(
      `--judgeModel (${opts.judgeModel}) must differ from the primary model ` +
        `(${primaryModel}); the whole point is a different-vendor judge`,
    );
  }

  const embedder = new MemoizingEmbedder(createTransformersEmbedder());
  const samples = loadPrefEvalSamples({
    form: opts.form,
    distractorTurns: opts.turns,
    maxInstances: opts.instances,
  });

  process.stdout.write(
    `Loaded ${samples.length} ${opts.form} instances (${opts.turns} distractors each)\n` +
      `Answerer + judge A: ${primaryModel}. Judge B: ${opts.judgeModel}.\n\n`,
  );

  const makeConsolidator: () => Consolidator = () =>
    new LLMConsolidator({
      complete: createOpenAICompleter(),
      extraInstructions: PREF_CONSOLIDATOR_INSTRUCTIONS,
    });

  const beliefTextByCaseId = new Map<string, string[]>();
  process.stdout.write("Building reMem belief stores...\n");
  const reMemRetrievals = await buildReMemRetrievals(samples, {
    embedder,
    makeConsolidator,
    recallOptions: { minScore: 0.3 },
    consolidateEvery: opts.batch,
    rankModes: ["blended"],
    onCaseBeliefs: (caseId, statements) => {
      beliefTextByCaseId.set(caseId, statements);
    },
    onSampleDone: (id, i, n) => {
      if (i === n || i % 25 === 0) {
        process.stdout.write(`  built ${i}/${n} samples (${id})\n`);
      }
    },
  });

  // Match the cli-prefeval judge pass: naive raw retrieval vs reMem in blended
  // mode (keeps the top raw preference turn alongside the consolidated belief).
  const judgeSystems: MemorySystem[] = [
    new NaiveVectorSystem(embedder),
    new PrecomputedSystem("reMem", reMemRetrievals.get("blended")!),
  ];

  const answerer = createOpenAICompleter();
  const judgeA = createOpenAICompleter();
  const judgeB = createOpenAICompleter({ model: opts.judgeModel });

  const rows: SystemAgreement[] = [];
  for (const system of judgeSystems) {
    const isReMem = system.name === "reMem";
    let followA = 0;
    let followB = 0;
    let labelMatch = 0;
    let bothFollow = 0;
    let aOnly = 0;
    let bOnly = 0;
    let neither = 0;
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i]!;
      const evalCase = sample.cases[0];
      if (!evalCase) continue;
      const retrieval = await system.retrieve(evalCase);
      const beliefs = isReMem
        ? (beliefTextByCaseId.get(evalCase.id) ?? [])
        : [];
      const snippets = contextSnippets(
        sample,
        retrieval.rankedObservationIds,
        opts.k,
        beliefs,
      );
      const answer = await generateAnswer(answerer, evalCase.query, snippets);
      const labelA = await judgeLabel(
        judgeA,
        sample.preference,
        evalCase.query,
        answer,
      );
      const labelB = await judgeLabel(
        judgeB,
        sample.preference,
        evalCase.query,
        answer,
      );
      const aFollows = labelA === "follows";
      const bFollows = labelB === "follows";
      if (aFollows) followA++;
      if (bFollows) followB++;
      if (labelA === labelB) labelMatch++;
      if (aFollows && bFollows) bothFollow++;
      else if (aFollows) aOnly++;
      else if (bFollows) bOnly++;
      else neither++;
      if ((i + 1) % 10 === 0 || i + 1 === samples.length) {
        process.stdout.write(
          `  ${system.name}: ${i + 1}/${samples.length} ` +
            `(A follows ${followA}, B follows ${followB})\n`,
        );
      }
    }
    const n = samples.length;
    rows.push({
      system: system.name,
      cases: n,
      followA,
      followB,
      followRateA: n === 0 ? 0 : followA / n,
      followRateB: n === 0 ? 0 : followB / n,
      labelAgreement: n === 0 ? 0 : labelMatch / n,
      followAgreement: n === 0 ? 0 : (bothFollow + neither) / n,
      kappa: cohensKappa(bothFollow, aOnly, bOnly, neither),
    });
  }

  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const naive = rows.find((r) => r.system !== "reMem");
  const reMem = rows.find((r) => r.system === "reMem");
  const gapA =
    reMem && naive ? reMem.followRateA - naive.followRateA : undefined;
  const gapB =
    reMem && naive ? reMem.followRateB - naive.followRateB : undefined;

  const lines = [
    "# PrefEval judge-agreement (self-judging robustness)",
    "",
    `Form: ${opts.form}. Distractor turns: ${opts.turns}. Instances: ${samples.length}.`,
    `Answerer + judge A: \`${primaryModel}\`. Judge B: \`${opts.judgeModel}\`.`,
    "Each answer is generated once and scored by both judges, so any difference",
    "is judge disagreement with zero answer variance.",
    "",
    "| System | Follow (judge A) | Follow (judge B) | Label agree | Follow agree | Cohen kappa |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.system} | ${pct(r.followRateA)} (${r.followA}/${r.cases}) | ` +
        `${pct(r.followRateB)} (${r.followB}/${r.cases}) | ` +
        `${pct(r.labelAgreement)} | ${pct(r.followAgreement)} | ${r.kappa.toFixed(3)} |`,
    );
  }
  if (gapA !== undefined && gapB !== undefined) {
    lines.push(
      "",
      `reMem - naive gap under judge A: ${(gapA * 100).toFixed(1)}pp; ` +
        `under judge B: ${(gapB * 100).toFixed(1)}pp.`,
    );
  }
  const markdown = lines.join("\n") + "\n";

  const date = new Date().toISOString().slice(0, 10);
  const outDir = join(
    process.cwd(),
    "eval",
    "results",
    `prefeval-${opts.form}-${date}-t${opts.turns}-judge2`,
  );
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "judge-agreement.md"), markdown, "utf8");
  writeFileSync(
    join(outDir, "judge-agreement.json"),
    JSON.stringify(
      { primaryModel, judgeModel: opts.judgeModel, gapA, gapB, rows },
      null,
      2,
    ),
    "utf8",
  );
  process.stdout.write("\n" + markdown);
  process.stdout.write(`\nWrote judge agreement to ${outDir}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
