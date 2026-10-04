import type { ChatCompleter } from "../consolidate/llm.js";
import type { MemorySystem } from "./types.js";
import type { PrefEvalSample } from "./prefeval.js";

// The PrefEval preference-following metric: does the assistant's answer actually
// honor the user's standing preference. It is the counterpart to qa-judge.ts (an
// answerer LLM plus a judge LLM, two calls per sample per system) but grades
// adherence to a preference rather than match to a gold answer, because PrefEval
// has no single reference answer, only a preference the answer must respect.
//
// Unlike the LoCoMo answerer, which is told to reply in a terse fact, the
// PrefEval answerer produces a normal, helpful assistant response to a
// recommendation-style question using only the retrieved memory. That is the
// realistic setting: the model was never handed the preference, only whatever
// memory surfaced. If memory failed to resurface the preference, a good answer
// will still violate it, which is exactly what we want to measure. The judge
// then classifies the answer against the ground-truth preference (which PrefEval
// provides for every form, including the implicit ones the answer never saw
// stated) into the PrefEval error taxonomy.

export const ANSWERER_SYSTEM = `You are a helpful personal assistant continuing a long conversation with a user. You are given memory snippets recalled from earlier in that conversation, then the user's new question.

Rules:
- Answer the question helpfully and specifically, as you normally would.
- Take the recalled memory snippets into account. They may reveal standing preferences, constraints, or context about the user.
- Do not invent details about the user that are not supported by the snippets.
- Keep it to a short, concrete recommendation (a few sentences).

Respond with strict JSON: {"answer": "your response"}.`;

export const JUDGE_SYSTEM = `You are grading whether an assistant's answer respects a user's standing preference.

You are given the user's PREFERENCE (ground truth), the QUESTION they asked, and the assistant's ANSWER. Classify the answer:
- "follows": the answer is consistent with the preference (it recommends or does what the preference implies, and avoids what the preference rules out).
- "violates": the answer recommends or endorses something the preference rules out, or ignores a constraint the preference sets.
- "unaware": the answer neither respects nor contradicts the preference in a way tied to it; it simply does not reflect any awareness of the preference (generic answer).
- "hallucinate": the answer invents a different or contradictory preference/constraint not stated by the user.

Only "follows" counts as success. Respond with strict JSON: {"label": "follows"|"violates"|"unaware"|"hallucinate"}.`;

export type PrefLabel = "follows" | "violates" | "unaware" | "hallucinate";
const LABELS: readonly PrefLabel[] = [
  "follows",
  "violates",
  "unaware",
  "hallucinate",
];

// Render the memory a system surfaces for one sample: the top-k retrieved turns
// plus, when supplied, the distilled belief statements the system consolidated.
// The beliefs block is the belief layer's actual contribution on PrefEval: on
// the implicit forms the raw turn only implies the preference ("I'll go with
// option 1"), so a naive retriever hands the answerer nothing it can act on,
// while a consolidated belief ("prefers in-person learning") states it outright.
// Passing beliefs only for the reMem system is how the two are compared fairly.
const BELIEF_KINDS = ["fact", "preference", "habit", "goal", "relationship"];

// Beliefs are canonicalized as "kind predicate value" (a tag triple). For the
// answerer we want the human-readable statement, not the taxonomy prefix, so
// drop the leading kind + snake_case predicate and keep the value. With the
// PrefEval consolidator instructions the value is a complete natural-language
// preference statement, so what remains reads as a sentence.
export function beliefToSentence(canonical: string): string {
  const parts = canonical.split(" ");
  if (parts.length >= 3 && BELIEF_KINDS.includes(parts[0] as string)) {
    return parts.slice(2).join(" ");
  }
  return canonical;
}

export function contextSnippets(
  sample: PrefEvalSample,
  ids: string[],
  k: number,
  beliefs: string[],
): string {
  const byId = new Map(
    sample.cases[0]?.observations.map((o) => [o.id, o.content]) ?? [],
  );
  const parts: string[] = [];
  if (beliefs.length > 0) {
    parts.push(
      "Known about the user:\n" +
        beliefs.map((b) => `- ${beliefToSentence(b)}`).join("\n"),
    );
  }
  const turns: string[] = [];
  for (const id of ids.slice(0, k)) {
    const text = byId.get(id);
    if (text) turns.push(`- ${text}`);
  }
  if (turns.length > 0) {
    parts.push("Recent conversation turns:\n" + turns.join("\n"));
  }
  return parts.length > 0 ? parts.join("\n\n") : "(no memory retrieved)";
}

function parseAnswer(raw: string): string {
  try {
    const parsed = JSON.parse(raw.trim()) as { answer?: unknown };
    if (typeof parsed.answer === "string") return parsed.answer.trim();
  } catch {
    // fall through
  }
  return raw.trim();
}

export async function generateAnswer(
  complete: ChatCompleter,
  question: string,
  snippets: string,
): Promise<string> {
  const raw = await complete([
    { role: "system", content: ANSWERER_SYSTEM },
    {
      role: "user",
      content: `MEMORY SNIPPETS:\n${snippets}\n\nUSER QUESTION: ${question}\n\nRespond with {"answer": "..."}.`,
    },
  ]);
  return parseAnswer(raw);
}

// Parse the judge's {"label": ...}. Any unrecognized response counts as
// "unaware" so a malformed judgement never inflates the success (follows) rate.
function parseLabel(raw: string): PrefLabel {
  try {
    const parsed = JSON.parse(raw.trim()) as { label?: unknown };
    if (
      typeof parsed.label === "string" &&
      (LABELS as readonly string[]).includes(parsed.label)
    ) {
      return parsed.label as PrefLabel;
    }
  } catch {
    // fall through
  }
  for (const label of LABELS) {
    if (new RegExp(`"label"\\s*:\\s*"${label}"`, "i").test(raw)) return label;
  }
  return "unaware";
}

export async function judgeLabel(
  complete: ChatCompleter,
  preference: string,
  question: string,
  answer: string,
): Promise<PrefLabel> {
  const raw = await complete([
    { role: "system", content: JUDGE_SYSTEM },
    {
      role: "user",
      content: `PREFERENCE: ${preference}\nQUESTION: ${question}\nANSWER: ${answer}\n\nRespond with {"label": "follows"|"violates"|"unaware"|"hallucinate"}.`,
    },
  ]);
  return parseLabel(raw);
}

export interface PrefScore {
  system: string;
  cases: number;
  follows: number;
  violates: number;
  unaware: number;
  hallucinate: number;
  // The headline: fraction of answers that honor the preference.
  followRate: number;
}

export interface PrefScoreOptions {
  k: number;
  answerer: ChatCompleter;
  judge: ChatCompleter;
  // Per-case distilled belief statements to hand the answerer alongside the
  // retrieved turns. Supply this only for the belief-forming system (reMem) so
  // the comparison isolates the belief layer's contribution; omit it for the
  // raw-retrieval baselines.
  beliefTextByCaseId?: Map<string, string[]>;
  onProgress?: (done: number, total: number) => void;
}

// Score one memory system over the PrefEval samples: retrieve, answer, judge
// adherence. Every sample is answerable (there is always a preference to honor),
// so all are scored.
export async function scorePrefForSystem(
  system: MemorySystem,
  samples: PrefEvalSample[],
  options: PrefScoreOptions,
): Promise<PrefScore> {
  const tally: Record<PrefLabel, number> = {
    follows: 0,
    violates: 0,
    unaware: 0,
    hallucinate: 0,
  };
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i] as PrefEvalSample;
    const evalCase = sample.cases[0];
    if (!evalCase) continue;
    const retrieval = await system.retrieve(evalCase);
    const beliefs = options.beliefTextByCaseId?.get(evalCase.id) ?? [];
    const snippets = contextSnippets(
      sample,
      retrieval.rankedObservationIds,
      options.k,
      beliefs,
    );
    const answer = await generateAnswer(
      options.answerer,
      evalCase.query,
      snippets,
    );
    const label = await judgeLabel(
      options.judge,
      sample.preference,
      evalCase.query,
      answer,
    );
    tally[label]++;
    options.onProgress?.(i + 1, samples.length);
  }
  const cases = samples.length;
  return {
    system: system.name,
    cases,
    follows: tally.follows,
    violates: tally.violates,
    unaware: tally.unaware,
    hallucinate: tally.hallucinate,
    followRate: cases === 0 ? 0 : tally.follows / cases,
  };
}
