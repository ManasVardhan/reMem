import { readFileSync } from "node:fs";
import { loadLocomoDataset } from "../locomo.js";
import { loadPrefEvalSamples, type PrefForm } from "../prefeval.js";
import type { DensityQuestion } from "./types.js";

// Take an evenly spaced subset spanning the whole list, rather than its head.
//
// This matters more than it looks. The questions arrive grouped: LoCoMo by
// conversation, PrefEval by preference form. A head-of-list limit of 300 would
// therefore return only the first conversation or two, and for PrefEval it
// would return 300 questions of the "explicit" form and none of the other two.
// The kappa validation sample is drawn with exactly such a limit, so a biased
// sample would decide the project's go/no-go gate on unrepresentative data.
//
// Striding is deterministic, needs no seed, and covers every group in
// proportion to its size.
export function strideSample<T>(items: T[], limit?: number): T[] {
  if (limit === undefined || limit >= items.length) return items;
  if (limit <= 0) return [];
  const step = items.length / limit;
  const out: T[] = [];
  for (let i = 0; i < limit; i++) out.push(items[Math.floor(i * step)]!);
  return out;
}

// The classifier sees the WHOLE conversation, not the annotated gold evidence
// turns. This is the difference between a measurement and a rigged one.
//
// LoCoMo's gold evidence is, by its loader's own definition, "the CURRENT
// observation only, not the superseded one" for a knowledge-update case. It is
// also a single turn for 73 percent of questions. Feeding only that makes a
// contradiction structurally impossible to observe, so the density would come
// back near zero for every benchmark regardless of what the benchmark contains.
// The paper predicts a low number here, which is exactly why it must not be
// obtained by construction.
//
// The cost of the wider context is a higher false-positive rate on a long
// conversation. That pushes measured density UP, against the paper's
// prediction, so the low result it produces is the conservative one.
export function locomoQuestions(path: string, limit?: number): DensityQuestion[] {
  const dataset = loadLocomoDataset(path);
  const out: DensityQuestion[] = [];
  for (const c of dataset.cases) {
    if (!c.answerable || c.goldAnswer === undefined) continue;
    const context = c.observations.map((o) => o.content);
    if (context.length === 0) continue;
    out.push({
      id: c.id,
      benchmark: "locomo",
      question: c.query,
      goldAnswer: c.goldAnswer,
      context,
    });
  }
  return strideSample(out, limit);
}

const PREF_FORMS: PrefForm[] = ["explicit", "choice-based", "persona-driven"];

// PrefEval cases carry no goldAnswer, because correctness there is judged as
// preference-following rather than answer-text match. The sample's `preference`
// is the ground truth a correct answer must respect, so it stands in as the
// gold value. Only loadPrefEvalSamples exposes it.
//
// All three forms are loaded. The options default to "explicit" alone, and
// reporting one third of the benchmark as its density would be wrong.
//
// distractorTurns is 50, not 0, for the same reason LoCoMo gets its whole
// conversation. With no distractors the explicit form's context is a single
// preference sentence, and one sentence cannot contradict anything, so the
// measurement could only ever return zero. 50 matches the midpoint of the
// density sweep already run in F3-a, which keeps this comparable to prior work.
export function prefevalQuestions(root: string, limit?: number): DensityQuestion[] {
  const out: DensityQuestion[] = [];
  for (const form of PREF_FORMS) {
    for (const sample of loadPrefEvalSamples({ root, form, distractorTurns: 50 })) {
      for (const c of sample.cases) {
        out.push({
          id: c.id,
          benchmark: `prefeval-${form}`,
          question: c.query,
          goldAnswer: sample.preference,
          context: c.observations.map((o) => o.content),
        });
      }
    }
  }
  return strideSample(out, limit);
}

interface MabRecord {
  query?: unknown;
  answer?: unknown;
  qa_pair_id?: unknown;
}

// The MemoryAgentBench run artifacts carry the question set with gold answers.
// Context is left empty by default: factconsolidation shares one context across
// all questions, and exactDensity is given that context separately as a fact
// list rather than through this field.
//
// contextPath is for the LLM classifier instead, which has no separate fact
// list to read from and needs the context on the question itself. The whole
// benchmark shares a single fact list across every question (that is what
// "shared context" means for factconsolidation), so the same lines are
// attached to each one here. That is not a bug: it mirrors how exactDensity
// itself receives the facts, just carried on a different field.
export function factconsolidationQuestions(
  resultsPath: string,
  contextPath?: string,
): DensityQuestion[] {
  const parsed = JSON.parse(readFileSync(resultsPath, "utf8")) as { data?: unknown };
  if (!Array.isArray(parsed.data)) {
    throw new Error(`factconsolidationQuestions: ${resultsPath} has no data array`);
  }
  const context =
    contextPath === undefined
      ? []
      : readFileSync(contextPath, "utf8")
          .split("\n")
          .filter((line) => line.length > 0);
  return (parsed.data as MabRecord[]).map((r, i) => {
    const answers = Array.isArray(r.answer) ? r.answer : [];
    const first = answers[0];
    return {
      id: typeof r.qa_pair_id === "string" ? r.qa_pair_id : `fc-${i}`,
      benchmark: "factconsolidation",
      question: typeof r.query === "string" ? r.query : "",
      goldAnswer: typeof first === "string" ? first : "",
      context,
    };
  });
}
