import { readFileSync } from "node:fs";
import type {
  Ability,
  EvalCase,
  EvalDataset,
  EvalObservation,
} from "./types.js";

// Loader for the real LoCoMo benchmark (snap-research/locomo, data/raw/
// locomo10.json). LoCoMo is ~10 very long multi-session dialogues with ~2k QA
// pairs. Its native shape is a per-sample `conversation` object whose keys are
// session_N (turn arrays) and session_N_date_time (a human date string), plus a
// `qa` list of {question, answer, evidence, category}. Each turn carries a
// stable `dia_id` (e.g. "D1:3"); the QA `evidence` lists those same dia_ids.
//
// That is exactly what the retrieval-grounded harness needs: dia_id is the
// observation id, and evidence is the gold set. So the whole benchmark scores
// offline (recall@k / MRR / abstention) with no LLM judge, matching the design's
// insistence that the memory layer is measured on what it surfaces, not on final
// answer text.
//
// Category taxonomy (from the paper): 1 multi-hop, 2 temporal, 3 open-domain,
// 4 single-hop, 5 adversarial. Categories 1-4 are answerable and gold-evidenced;
// category 5 is adversarial and the correct behavior is to abstain, so its gold
// set is empty regardless of the misleading evidence the dataset lists.

interface LocomoTurn {
  speaker?: string;
  dia_id?: string;
  text?: string;
}

interface LocomoQA {
  question: string;
  answer?: string;
  adversarial_answer?: string;
  evidence?: string[];
  category: number;
}

interface LocomoConversation {
  [key: string]: unknown;
}

interface LocomoSample {
  sample_id?: string;
  qa: LocomoQA[];
  conversation: LocomoConversation;
}

export interface LoadLocomoOptions {
  // Cap the number of dialogues loaded (LoCoMo has 10). Omit for all.
  maxSamples?: number;
  // Cap QA cases per dialogue (deterministic head). Omit for all.
  maxQaPerSample?: number;
  // Restrict to these LoCoMo categories (1-5). Omit for all.
  categories?: number[];
}

// One LoCoMo dialogue: its shared observation stream plus every QA case built
// over it. LoCoMo is naturally grouped this way (all a sample's QA reason over
// the same conversation), which is exactly what a shared-store eval needs:
// ingest + consolidate the dialogue once, then answer each QA read-only.
export interface LocomoEvalSample {
  sampleId: string;
  observations: EvalObservation[];
  cases: EvalCase[];
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

// Parse LoCoMo's "1:56 pm on 8 May, 2023" session timestamp into epoch ms.
// Returns undefined when the string does not match, so the caller can fall back
// to positional ordering.
function parseSessionTs(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const m =
    /(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([a-z]+),?\s+(\d{4})/i.exec(
      raw,
    );
  if (!m) return undefined;
  let hour = Number(m[1]);
  const min = Number(m[2]);
  const ampm = (m[3] as string).toLowerCase();
  const day = Number(m[4]);
  const month = MONTHS[(m[5] as string).slice(0, 3).toLowerCase()];
  const year = Number(m[6]);
  if (month === undefined) return undefined;
  if (ampm === "pm" && hour !== 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  return Date.UTC(year, month, day, hour, min);
}

// LoCoMo is a two-human chat; from the assistant's memory perspective both
// participants are the observed "user" side.
function abilityFor(category: number): Ability {
  return category === 5 ? "abstention" : "extraction";
}

// Flatten a sample's conversation into an ordered observation stream. Turns are
// ordered by session index then position; each session's parsed date_time sets
// the base ts (falling back to a synthetic monotonic base when unparseable) and
// per-turn offset preserves within-session order.
function sampleObservations(conv: LocomoConversation): EvalObservation[] {
  const sessionKeys = Object.keys(conv)
    .filter((k) => /^session_\d+$/.test(k))
    .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));

  const out: EvalObservation[] = [];
  sessionKeys.forEach((key, sessionIdx) => {
    const turns = conv[key];
    if (!Array.isArray(turns)) return;
    const parsed = parseSessionTs(conv[`${key}_date_time`]);
    // 1 day between synthetic sessions, 1 minute between synthetic turns: keeps
    // strict chronological order even without real dates.
    const baseTs = parsed ?? sessionIdx * 86_400_000;
    (turns as LocomoTurn[]).forEach((turn, turnIdx) => {
      const content = turn.text ?? "";
      const id = turn.dia_id;
      if (!id || content.length === 0) return;
      out.push({
        id,
        source: "slack",
        actor: "user",
        content,
        ts: baseTs + turnIdx * 60_000,
        contextSnapshot: { surface: "locomo", session: key },
      });
    });
  });
  return out;
}

// Build the eval cases for one sample from its QA list, reusing the shared
// observation stream. Answerable QA without any evidence cannot be scored on
// retrieval and are dropped; adversarial (category 5) QA are kept as abstention
// cases with an empty gold set.
function sampleCases(
  sample: LocomoSample,
  observations: EvalObservation[],
  sampleId: string,
  options: LoadLocomoOptions,
): EvalCase[] {
  const present = new Set(observations.map((o) => o.id));
  const cases: EvalCase[] = [];
  let qaIndex = 0;
  for (const qa of sample.qa) {
    if (options.categories && !options.categories.includes(qa.category))
      continue;
    if (
      options.maxQaPerSample !== undefined &&
      cases.length >= options.maxQaPerSample
    ) {
      break;
    }
    const answerable = qa.category !== 5;
    const evidence = (qa.evidence ?? []).filter((id) => present.has(id));
    if (answerable && evidence.length === 0) continue; // unscoreable
    const goldAnswer = answerable ? qa.answer : undefined;
    cases.push({
      id: `${sampleId}-q${qaIndex++}-c${qa.category}`,
      ability: abilityFor(qa.category),
      observations,
      query: qa.question,
      context: {},
      goldObservationIds: answerable ? evidence : [],
      ...(goldAnswer !== undefined ? { goldAnswer: String(goldAnswer) } : {}),
      answerable,
    });
  }
  return cases;
}

// Grouped load: one entry per dialogue, keeping its observations and QA cases
// together. This is the primitive the shared-store LoCoMo driver builds on.
// Samples whose QA all get filtered out (e.g. category filter) are dropped.
export function loadLocomoSamples(
  path: string,
  options: LoadLocomoOptions = {},
): LocomoEvalSample[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as LocomoSample[];
  const samples =
    options.maxSamples !== undefined ? raw.slice(0, options.maxSamples) : raw;

  const out: LocomoEvalSample[] = [];
  samples.forEach((sample, idx) => {
    const sampleId = sample.sample_id ?? `sample${idx}`;
    const observations = sampleObservations(sample.conversation);
    const cases = sampleCases(sample, observations, sampleId, options);
    if (cases.length > 0) out.push({ sampleId, observations, cases });
  });
  return out;
}

export function loadLocomoDataset(
  path: string,
  options: LoadLocomoOptions = {},
): EvalDataset {
  const cases = loadLocomoSamples(path, options).flatMap((s) => s.cases);
  return { name: "locomo10", cases };
}
