import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Actor } from "../types/index.js";
import type { EvalCase, EvalDataset, EvalObservation } from "./types.js";

// Loader for the PrefEval benchmark (amazon-science/PrefEval). PrefEval measures
// whether an assistant honors a user's stated preference across a long,
// distractor-filled conversation. It ships the preference in three forms of
// increasing subtlety:
//   - explicit: the user states the preference outright in one turn.
//   - choice-based: the user never states it; it is implied by which option
//     they pick from an assistant's list.
//   - persona-driven: it is woven into a multi-turn persona conversation, never
//     announced as a preference.
// Every instance ends with a question whose natural answer would violate the
// preference unless the model still remembers (explicit) or inferred (implicit)
// it.
//
// Why this is the complement to LoCoMo. LoCoMo is episodic QA: the gold is a
// specific evidence turn and observations-first ranking wins because raw recall
// surfaces that exact turn (docs/FINDINGS.md F1/F2). PrefEval is the opposite
// regime: the gold is a durable preference, and on the implicit forms it is
// never stated in any single turn at all. Naive vector-RAG has nothing verbatim
// to retrieve; only a consolidated preference belief captures it. LoCoMo
// structurally penalizes that distillation; PrefEval rewards it, and the
// implicit forms are where the belief layer should win outright.
//
// Mapping to the shared-store harness. Each instance becomes one sample (its own
// belief store): the preference-bearing turn(s) come first and are the gold, the
// distractor turns are appended as noise, and the query is the single answerable
// case. Offline retrieval metrics (recall@k, MRR, grounded top-1) then answer
// "did memory resurface the preference-bearing context at query time" with no
// LLM judge. Whether the generated answer actually honors the preference is the
// separate model-judged axis (pref-judge.ts); it reads sample.preference, which
// PrefEval provides as ground truth for every form including the implicit ones.

export type PrefForm = "explicit" | "choice-based" | "persona-driven";

// PrefEval-specific guidance appended to the LLM consolidator's system prompt
// (via LLMConsolidator extraInstructions). The shared consolidator prompt is
// tuned for LoCoMo episodic facts and, on PrefEval, was NOOPing on stated
// preferences ~45% of the time and, when it did fire, compressing aversions
// ("I avoid textbooks") into a positive topic tag that dropped the negation.
// This guidance is layered on only for PrefEval runs so it cannot regress the
// shared LoCoMo consolidator. It does NOT edit the base prompt.
export const PREF_CONSOLIDATOR_INSTRUCTIONS = `PrefEval focus: the user expresses standing PREFERENCES, frequently as aversions ("I avoid X", "I dislike Y", "I find Z disorienting", "not a fan of W") or by choosing an option ("I'll go with option 2 because ..."). Capturing these preferences accurately is the priority.

- ALWAYS create (or reinforce/contradict) a preference belief whenever the user reveals a like, dislike, aversion, or makes a choice that implies what they prefer, even when surrounding turns are about unrelated topics. Do not NOOP on a stated or clearly implied preference.
- A preference belief's "value" MUST be a complete, self-contained natural-language statement that preserves any negation or aversion. Good: "avoids flashcards and prefers narrative, story-based memorization"; "dislikes paid subscriptions and prefers free, open-source resources"; "finds VR simulations disorienting and prefers not to use them". Never reduce it to a positive topic tag that drops the "avoid"/"dislike"/"not" part.
- Ignore unrelated distractor chatter (coding help, trivia, one-off task questions) unless it reveals a durable user preference. Do not create beliefs about transient task content.`;

interface ExplicitInstance {
  preference: string;
  question: string;
  explanation?: string;
}

interface ChoiceConversation {
  query: string;
  assistant_options: string;
  user_selection: string;
  assistant_acknowledgment: string;
}

interface ChoiceInstance {
  preference: string;
  question: string;
  explanation?: string;
  conversation: ChoiceConversation;
}

interface PersonaTurn {
  user: string;
  assistant: string;
}

interface PersonaInstance {
  preference: string;
  question: string;
  explanation?: string;
  persona?: string;
  conversation: Record<string, PersonaTurn>;
}

interface DistractorTurn {
  content: string;
  role: string;
}

interface DistractorConversation {
  conversation_id: string;
  conversation: DistractorTurn[];
}

// One PrefEval instance: the preference-plus-distractors observation stream and
// the single query case built over it. Structurally a superset of a LoCoMo
// sample (sampleId/observations/cases), so the same shared-store driver ingests
// it unchanged; the extra fields (preference, form) carry the ground truth the
// preference-following judge needs.
export interface PrefEvalSample {
  sampleId: string;
  observations: EvalObservation[];
  cases: EvalCase[];
  // The ground-truth preference this instance tests, verbatim from PrefEval.
  // The judge grades the generated answer against this even on the implicit
  // forms where it is never stated in any observation.
  preference: string;
  explanation?: string;
  form: PrefForm;
}

export interface LoadPrefEvalOptions {
  // Which preference form to load. Defaults to explicit.
  form?: PrefForm;
  // Root of the downloaded benchmark (contains explicit_preference/,
  // implicit_preference/, filtered_inter_turns.json). Defaults to the standard
  // download path.
  root?: string;
  // Restrict to these topic file basenames (without .json). Omit for all.
  topics?: string[];
  // Cap total instances loaded, deterministic across topics in filename order.
  maxInstances?: number;
  // Cap instances per topic (deterministic head). Omit for all.
  maxPerTopic?: number;
  // Number of distractor turns inserted between the preference-bearing turns and
  // the query. The recall-pressure knob: 0 puts the query right after the
  // preference context; larger values reproduce PrefEval's multi-turn
  // degradation sweep. Turns are taken deterministically from the front of the
  // shared distractor pool. Defaults to 0.
  distractorTurns?: number;
}

const DEFAULT_ROOT = join(process.cwd(), "data", "raw", "prefeval");

const BASE_TS = 1_000_000_000_000; // fixed positive epoch base; ordering is what matters
const TURN_MS = 60_000; // one minute between synthetic turns

function formDir(root: string, form: PrefForm): string {
  if (form === "explicit") return join(root, "explicit_preference");
  return join(root, "implicit_preference", form);
}

// Flatten every distractor conversation into a single ordered turn pool. The
// same pool front-slice is reused across instances so distractor content is
// identical run to run (deterministic) and the memoizing embedder collapses it
// to embed-once cost regardless of how many instances reuse it.
function loadDistractorPool(root: string): DistractorTurn[] {
  const path = join(root, "filtered_inter_turns.json");
  const convs = JSON.parse(readFileSync(path, "utf8")) as DistractorConversation[];
  const pool: DistractorTurn[] = [];
  for (const conv of convs) {
    for (const turn of conv.conversation) {
      if (typeof turn.content === "string" && turn.content.length > 0) {
        pool.push({ content: turn.content, role: turn.role });
      }
    }
  }
  return pool;
}

// Resolve which topic files to load, in a stable filename order so maxInstances
// slices deterministically.
function topicFiles(dir: string, topics?: string[]): string[] {
  const all = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (!topics) return all.map((f) => join(dir, f));
  const want = new Set(topics);
  return all
    .filter((f) => want.has(basename(f, ".json")))
    .map((f) => join(dir, f));
}

// A preference-bearing turn plus whether it is gold. Loaders emit the ordered
// lead-in turns for an instance; buildSample appends the distractors, stamps
// timestamps, and attaches the query case.
interface LeadTurn {
  actor: Actor;
  content: string;
  gold: boolean;
}

function buildSample(
  sampleId: string,
  form: PrefForm,
  lead: LeadTurn[],
  distractors: DistractorTurn[],
  question: string,
  preference: string,
  explanation: string | undefined,
): PrefEvalSample {
  const observations: EvalObservation[] = [];
  const goldIds: string[] = [];
  let ts = BASE_TS;
  lead.forEach((turn, i) => {
    const id = `${sampleId}-l${i}`;
    observations.push({
      id,
      source: "chat",
      actor: turn.actor,
      content: turn.content,
      ts,
      contextSnapshot: { surface: "prefeval", form },
    });
    if (turn.gold) goldIds.push(id);
    ts += TURN_MS;
  });
  distractors.forEach((turn, j) => {
    observations.push({
      id: `${sampleId}-d${j}`,
      source: "chat",
      actor: turn.role === "assistant" ? "assistant" : "user",
      content: turn.content,
      ts,
      contextSnapshot: { surface: "prefeval", form },
    });
    ts += TURN_MS;
  });

  const evalCase: EvalCase = {
    id: `${sampleId}-q`,
    ability: "preference",
    observations,
    query: question,
    context: {},
    // Retrieval gold is the preference-bearing turn(s). On the implicit forms
    // this is the turn that reveals the preference, not a verbatim statement of
    // it, so recall here is a proxy; adherence is the judged axis. No goldAnswer:
    // correctness is preference-following, not answer-text match.
    goldObservationIds: goldIds,
    answerable: true,
  };

  return {
    sampleId,
    observations,
    cases: [evalCase],
    preference,
    form,
    ...(explanation !== undefined ? { explanation } : {}),
  };
}

// Lead-in turns per form. Explicit: one user turn that states the preference.
// Choice-based: the four-turn option/selection exchange whose selection turn
// carries the (implicit) preference. Persona-driven: the whole persona
// conversation, with every user turn marked gold because the preference is
// diffused across them.
function explicitLead(inst: ExplicitInstance): LeadTurn[] {
  return [{ actor: "user", content: inst.preference, gold: true }];
}

function choiceLead(inst: ChoiceInstance): LeadTurn[] {
  const c = inst.conversation;
  return [
    { actor: "user", content: c.query, gold: false },
    { actor: "assistant", content: c.assistant_options, gold: false },
    { actor: "user", content: c.user_selection, gold: true },
    { actor: "assistant", content: c.assistant_acknowledgment, gold: false },
  ];
}

function personaLead(inst: PersonaInstance): LeadTurn[] {
  const turns: LeadTurn[] = [];
  const keys = Object.keys(inst.conversation).sort(
    (a, b) => Number(a) - Number(b),
  );
  for (const k of keys) {
    const turn = inst.conversation[k];
    if (!turn) continue;
    turns.push({ actor: "user", content: turn.user, gold: true });
    turns.push({ actor: "assistant", content: turn.assistant, gold: false });
  }
  return turns;
}

function leadFor(form: PrefForm, raw: unknown): LeadTurn[] {
  if (form === "explicit") return explicitLead(raw as ExplicitInstance);
  if (form === "choice-based") return choiceLead(raw as ChoiceInstance);
  return personaLead(raw as PersonaInstance);
}

// Grouped load: one sample per PrefEval instance, ready for the shared-store
// reMem driver. Topics are read in filename order; maxInstances caps the total
// across topics; distractorTurns sets how many noise turns sit between the
// preference context and the query.
export function loadPrefEvalSamples(
  options: LoadPrefEvalOptions = {},
): PrefEvalSample[] {
  const root = options.root ?? DEFAULT_ROOT;
  const form = options.form ?? "explicit";
  const nDistractors = Math.max(0, options.distractorTurns ?? 0);
  const distractors = loadDistractorPool(root).slice(0, nDistractors);

  const files = topicFiles(formDir(root, form), options.topics);
  const out: PrefEvalSample[] = [];
  for (const file of files) {
    const topic = basename(file, ".json");
    const instances = JSON.parse(readFileSync(file, "utf8")) as {
      preference: string;
      question: string;
      explanation?: string;
    }[];
    let perTopic = 0;
    for (let i = 0; i < instances.length; i++) {
      if (options.maxPerTopic !== undefined && perTopic >= options.maxPerTopic) {
        break;
      }
      if (
        options.maxInstances !== undefined &&
        out.length >= options.maxInstances
      ) {
        return out;
      }
      const inst = instances[i];
      if (!inst) continue;
      const sampleId = `${form}-${topic}-i${i}`;
      out.push(
        buildSample(
          sampleId,
          form,
          leadFor(form, inst),
          distractors,
          inst.question,
          inst.preference,
          inst.explanation,
        ),
      );
      perTopic++;
    }
  }
  return out;
}

export function loadPrefEvalDataset(
  options: LoadPrefEvalOptions = {},
): EvalDataset {
  const cases = loadPrefEvalSamples(options).flatMap((s) => s.cases);
  return { name: `prefeval-${options.form ?? "explicit"}`, cases };
}
