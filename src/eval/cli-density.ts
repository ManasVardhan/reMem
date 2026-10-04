import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createOpenAICompleter } from "../consolidate/llm.js";
import { classifyAll } from "./density/classifier.js";
import { factconsolidationQuestions, locomoQuestions, prefevalQuestions } from "./density/loaders.js";
import { wilsonInterval } from "./density/stats.js";
import type { DensityQuestion, DensityReport } from "./density/types.js";

// Measures contradiction density for LoCoMo, PrefEval, and factconsolidation.
// factconsolidation's density is also derivable exactly by exactDensity; running
// the same LLM classifier used on LoCoMo and PrefEval against it here is what
// makes the classifier's near-zero result on those two benchmarks falsifiable.
//
// Usage:
//   pnpm eval:density --benchmark locomo --limit 50 --out eval/density/results/locomo.json
//   pnpm eval:density --benchmark prefeval --limit 50 --out eval/density/results/prefeval.json
//   pnpm eval:density --benchmark factconsolidation --results <path> --context <path> --out eval/density/results/factconsolidation.json

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required argument --${name}`);
  }
  return process.argv[i + 1]!;
}

async function main(): Promise<void> {
  const benchmark = arg("benchmark");
  const limitRaw = arg("limit", "");
  const limit = limitRaw === "" ? undefined : Number(limitRaw);
  const out = arg("out", `eval/density/results/${benchmark}.json`);

  let questions: DensityQuestion[];
  if (benchmark === "locomo") {
    questions = locomoQuestions(arg("data", "data/raw/locomo10.json"), limit);
  } else if (benchmark === "prefeval") {
    questions = prefevalQuestions(arg("data", "data/raw/prefeval"), limit);
  } else if (benchmark === "factconsolidation") {
    const results = arg("results", "");
    const context = arg("context", "");
    if (results === "" || context === "") {
      throw new Error(
        "factconsolidation requires both --results and --context",
      );
    }
    questions = factconsolidationQuestions(results, context);
  } else {
    throw new Error(
      `unknown benchmark ${benchmark}, expected locomo, prefeval, or factconsolidation`,
    );
  }

  console.log(`classifying ${questions.length} questions from ${benchmark}`);
  const complete = createOpenAICompleter();
  const verdicts = await classifyAll(complete, questions);

  const contradictions = verdicts.filter((v) => v.label === "contradiction").length;
  const failures = verdicts.filter((v) => v.failed).length;
  const report: DensityReport = {
    benchmark,
    n: verdicts.length,
    contradictions,
    density: verdicts.length === 0 ? 0 : contradictions / verdicts.length,
    ci95: wilsonInterval(contradictions, verdicts.length),
    failures,
  };

  // A failed call is recorded as no-contradiction, which drags the density
  // down. That is the direction that flatters the paper's thesis, so a run with
  // any failures must never be quietly reported as a result.
  if (failures > 0) {
    console.error(
      `WARNING: ${failures} of ${verdicts.length} classifier calls failed. ` +
        `The density below is an underestimate. Do not report this run.`,
    );
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ report, verdicts }, null, 2));
  console.log(
    `${benchmark}: ${contradictions}/${report.n} = ${(report.density * 100).toFixed(1)}% ` +
      `[${(report.ci95[0] * 100).toFixed(1)}, ${(report.ci95[1] * 100).toFixed(1)}]`,
  );
  console.log(`wrote ${out}`);
}

void main();
