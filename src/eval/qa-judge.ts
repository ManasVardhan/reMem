import type { ChatCompleter } from "../consolidate/llm.js";
import type { EvalCase, MemorySystem } from "./types.js";

// The standard LoCoMo QA-accuracy metric: end-to-end answer correctness, not
// retrieval grounding. For each answerable case a system's top-k retrieved
// observations are handed to an answerer LLM, which produces a free-text answer;
// an LLM judge then decides whether that answer matches the gold answer. This is
// the model-judged axis referenced in types.ts and the number that is
// comparable to published LoCoMo results (Mem0, MemGPT, etc.), which all report
// LLM-judged QA accuracy rather than recall@k.
//
// It is deliberately separate from the offline retrieval metrics: it needs live
// LLM calls (two per case per system) and real spend, so it only runs behind the
// --qa flag. The answerer and judge completers are injected so the model is
// configurable and the module is testable with canned completers.

const ANSWERER_SYSTEM = `You answer a question using ONLY the provided memory snippets from a long personal conversation. Each snippet is one chat turn.

Rules:
- Answer as briefly as possible: a date, a name, a place, a short phrase. No explanation, no full sentences unless required.
- Use only the snippets. Do not invent facts not present in them.
- For "when" questions, give the date exactly as it appears in the snippets.
- If the snippets do not contain the answer, use "NO_ANSWER" as the value.

Respond with strict JSON: {"answer": "your short answer"}.`;

const JUDGE_SYSTEM = `You are grading a predicted answer against the gold answer for a question about a conversation. Judge semantic correctness, not wording.

A prediction is CORRECT if it conveys the same core fact as the gold answer: the same date (any equivalent format), the same name, place, number, or entity, or a clear paraphrase. Extra harmless detail is fine. A prediction is INCORRECT if it states a different fact, is missing the key fact, contradicts the gold, or says it has no answer while the gold has one.

Respond with strict JSON: {"correct": true} or {"correct": false}.`;

// Render the observation texts behind a system's top-k ids for one case. The
// system returns ids mapped back to the eval dataset's dia_ids, so they resolve
// against the case's own observation list.
function contextSnippets(evalCase: EvalCase, ids: string[], k: number): string {
  const byId = new Map(evalCase.observations.map((o) => [o.id, o.content]));
  const lines: string[] = [];
  for (const id of ids.slice(0, k)) {
    const text = byId.get(id);
    if (text) lines.push(`- ${text}`);
  }
  return lines.length > 0 ? lines.join("\n") : "(no snippets retrieved)";
}

// Pull the answer string out of the model's JSON reply. Falls back to the raw
// trimmed text if the JSON is malformed, so a stray response still gets judged
// rather than lost.
function parseAnswer(raw: string): string {
  try {
    const parsed = JSON.parse(raw.trim()) as { answer?: unknown };
    if (typeof parsed.answer === "string") return parsed.answer.trim();
  } catch {
    // fall through
  }
  return raw.trim();
}

async function generateAnswer(
  complete: ChatCompleter,
  question: string,
  snippets: string,
): Promise<string> {
  const raw = await complete([
    { role: "system", content: ANSWERER_SYSTEM },
    {
      role: "user",
      content: `MEMORY SNIPPETS:\n${snippets}\n\nQUESTION: ${question}\n\nRespond with {"answer": "..."}.`,
    },
  ]);
  return parseAnswer(raw);
}

// Parse the judge's {"correct": bool}. Any unparseable response counts as
// incorrect, so a malformed judgement never inflates the score.
function parseJudge(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw.trim()) as { correct?: unknown };
    return parsed.correct === true;
  } catch {
    return /"correct"\s*:\s*true/i.test(raw);
  }
}

async function judgeCorrect(
  complete: ChatCompleter,
  question: string,
  gold: string,
  predicted: string,
): Promise<boolean> {
  const raw = await complete([
    { role: "system", content: JUDGE_SYSTEM },
    {
      role: "user",
      content: `QUESTION: ${question}\nGOLD ANSWER: ${gold}\nPREDICTED ANSWER: ${predicted}\n\nRespond with {"correct": true|false}.`,
    },
  ]);
  return parseJudge(raw);
}

export interface QaScore {
  system: string;
  cases: number; // answerable cases scored
  correct: number;
  accuracy: number;
}

export interface QaScoreOptions {
  k: number;
  answerer: ChatCompleter;
  judge: ChatCompleter;
  // Progress callback (case index, total) for long runs.
  onProgress?: (done: number, total: number) => void;
}

// Score one memory system end-to-end over the answerable cases of a dataset.
// Only answerable cases have a gold answer; abstention cases are excluded, which
// matches how published LoCoMo QA accuracy is reported over the answerable set.
export async function scoreQaForSystem(
  system: MemorySystem,
  cases: EvalCase[],
  options: QaScoreOptions,
): Promise<QaScore> {
  const answerable = cases.filter(
    (c) => c.answerable && c.goldAnswer !== undefined,
  );
  let correct = 0;
  for (let i = 0; i < answerable.length; i++) {
    const evalCase = answerable[i] as EvalCase;
    const retrieval = await system.retrieve(evalCase);
    const snippets = contextSnippets(
      evalCase,
      retrieval.rankedObservationIds,
      options.k,
    );
    const predicted = await generateAnswer(
      options.answerer,
      evalCase.query,
      snippets,
    );
    const ok = await judgeCorrect(
      options.judge,
      evalCase.query,
      evalCase.goldAnswer as string,
      predicted,
    );
    if (ok) correct++;
    options.onProgress?.(i + 1, answerable.length);
  }
  return {
    system: system.name,
    cases: answerable.length,
    correct,
    accuracy: answerable.length === 0 ? 0 : correct / answerable.length,
  };
}
