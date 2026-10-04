import { existsSync, readFileSync, readdirSync } from "fs"
import { basename, join } from "path"
import type { Benchmark, BenchmarkConfig, QuestionFilter } from "../../types/benchmark"
import type {
  UnifiedQuestion,
  UnifiedSession,
  UnifiedMessage,
  QuestionTypeRegistry,
} from "../../types/unified"
import type {
  PrefEvalChoiceInstance,
  PrefEvalDistractorConversation,
  PrefEvalDistractorTurn,
  PrefEvalExplicitInstance,
  PrefEvalPersonaInstance,
} from "./types"
import { logger } from "../../utils/logger"

// PrefEval is already downloaded alongside the rest of the shared eval data,
// one level up from this repo, not under memorybench's own data/benchmarks.
const DEFAULT_DATA_PATH = "../data/raw/prefeval"

// PrefEval ships the preference in three forms of increasing subtlety:
//   - explicit: the user states the preference outright in one turn.
//   - choice-based: never stated, implied by which option the user picks.
//   - persona-driven: woven across several turns, never announced.
// They behave very differently under a memory system, so they stay separate
// question types below instead of being merged.
type PrefForm = "explicit" | "choice-based" | "persona-driven"

const FORMS: PrefForm[] = ["explicit", "choice-based", "persona-driven"]

// The "preference-" prefix is load-bearing. getJudgePromptForType (see
// ../../prompts/defaults.ts) returns PREFERENCE_JUDGE_PROMPT for any question
// type whose lowercased string contains "preference", and buildJudgePrompt
// (../../judges/base.ts) then labels groundTruth as "Rubric" instead of
// "Ground Truth Answer". That is the scoring PrefEval needs: a response is
// correct if it honors the preference, not if it matches an exact string.
const FORM_TO_QUESTION_TYPE: Record<PrefForm, string> = {
  explicit: "preference-explicit",
  "choice-based": "preference-choice-based",
  "persona-driven": "preference-persona-driven",
}

export const PREFEVAL_QUESTION_TYPES: QuestionTypeRegistry = {
  "preference-explicit": {
    id: "preference-explicit",
    alias: "explicit",
    description: "Preference stated outright in a single turn",
  },
  "preference-choice-based": {
    id: "preference-choice-based",
    alias: "choice",
    description: "Preference never stated, implied by which option the user picks",
  },
  "preference-persona-driven": {
    id: "preference-persona-driven",
    alias: "persona",
    description: "Preference woven across several turns, never announced",
  },
}

// Distractor turns appended after the preference-bearing turns and before the
// final question, taken deterministically from the front of the shared pool
// in filtered_inter_turns.json. This is the noise PrefEval uses to test
// whether the preference survives a long, off-topic conversation. The same
// front-slice is reused across every instance so the haystack is identical
// run to run.
const DEFAULT_DISTRACTOR_TURNS = 20

function formDir(root: string, form: PrefForm): string {
  if (form === "explicit") return join(root, "explicit_preference")
  return join(root, "implicit_preference", form)
}

// Flatten every distractor conversation in filtered_inter_turns.json into a
// single ordered turn pool.
function loadDistractorPool(root: string): PrefEvalDistractorTurn[] {
  const path = join(root, "filtered_inter_turns.json")
  const convs: PrefEvalDistractorConversation[] = JSON.parse(readFileSync(path, "utf8"))
  const pool: PrefEvalDistractorTurn[] = []
  for (const conv of convs) {
    for (const turn of conv.conversation) {
      if (typeof turn.content === "string" && turn.content.length > 0) {
        pool.push({ content: turn.content, role: turn.role })
      }
    }
  }
  return pool
}

function topicFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => join(dir, f))
}

// A lead-in turn plus whether it is the preference-bearing (gold) turn. The
// per-form builders below preserve each instance's native conversational
// order; they never extract just the gold turn and hoist it to the front.
interface LeadTurn {
  role: "user" | "assistant"
  content: string
  gold: boolean
}

// Explicit: one user turn that states the preference outright.
function explicitLead(inst: PrefEvalExplicitInstance): LeadTurn[] {
  return [{ role: "user", content: inst.preference, gold: true }]
}

// Choice-based: the four-turn option/selection exchange in its original
// order. The preference is never stated; it is implied by user_selection,
// which is why that turn (and only that turn) is gold.
function choiceLead(inst: PrefEvalChoiceInstance): LeadTurn[] {
  const c = inst.conversation
  return [
    { role: "user", content: c.query, gold: false },
    { role: "assistant", content: c.assistant_options, gold: false },
    { role: "user", content: c.user_selection, gold: true },
    { role: "assistant", content: c.assistant_acknowledgment, gold: false },
  ]
}

// Persona-driven: the whole persona conversation, turns 0..N in order. Every
// user turn is marked gold because the preference is diffused across the
// conversation rather than confined to one turn.
function personaLead(inst: PrefEvalPersonaInstance): LeadTurn[] {
  const turns: LeadTurn[] = []
  const keys = Object.keys(inst.conversation).sort((a, b) => Number(a) - Number(b))
  for (const key of keys) {
    const turn = inst.conversation[key]
    if (!turn) continue
    turns.push({ role: "user", content: turn.user, gold: true })
    turns.push({ role: "assistant", content: turn.assistant, gold: false })
  }
  return turns
}

function leadFor(form: PrefForm, raw: unknown): LeadTurn[] {
  if (form === "explicit") return explicitLead(raw as PrefEvalExplicitInstance)
  if (form === "choice-based") return choiceLead(raw as PrefEvalChoiceInstance)
  return personaLead(raw as PrefEvalPersonaInstance)
}

export class PrefEvalBenchmark implements Benchmark {
  name = "prefeval"
  private questions: UnifiedQuestion[] = []
  private sessionsMap: Map<string, UnifiedSession[]> = new Map()

  async load(config?: BenchmarkConfig): Promise<void> {
    const dataPath = config?.dataPath || DEFAULT_DATA_PATH
    const root = join(process.cwd(), dataPath)

    if (!existsSync(root)) {
      throw new Error(
        `PrefEval data not found at ${root}. Download amazon-science/PrefEval into ` +
          `data/raw/prefeval (explicit_preference/, implicit_preference/, ` +
          `filtered_inter_turns.json) before running this benchmark.`
      )
    }

    const distractors = loadDistractorPool(root).slice(0, DEFAULT_DISTRACTOR_TURNS)

    for (const form of FORMS) {
      this.loadForm(root, form, distractors)
    }

    logger.info(`Loaded ${this.questions.length} questions from PrefEval`)
  }

  private loadForm(root: string, form: PrefForm, distractors: PrefEvalDistractorTurn[]): void {
    const questionType = FORM_TO_QUESTION_TYPE[form]
    const files = topicFiles(formDir(root, form))

    for (const file of files) {
      const topic = basename(file, ".json")
      const instances = JSON.parse(readFileSync(file, "utf8")) as {
        preference: string
        question: string
        explanation?: string
      }[]

      instances.forEach((inst, i) => {
        const questionId = `${questionType}-${topic}-i${i}`
        const session = this.buildSession(questionId, form, leadFor(form, inst), distractors)

        this.questions.push({
          questionId,
          question: inst.question,
          questionType,
          groundTruth: inst.preference,
          haystackSessionIds: [session.sessionId],
          metadata: {
            topic,
            form,
            explanation: inst.explanation,
          },
        })

        this.sessionsMap.set(questionId, [session])
      })
    }
  }

  // PrefEval's source data carries no timestamps and no named speakers: there
  // is no date field anywhere in explicit_preference/, implicit_preference/,
  // or filtered_inter_turns.json, and turns are labeled only "user" or
  // "assistant", not e.g. "Alice"/"Bob" the way LoCoMo's are. So messages get
  // no timestamp and no speaker, unlike the LoCoMo benchmark.
  private buildSession(
    questionId: string,
    form: PrefForm,
    lead: LeadTurn[],
    distractors: PrefEvalDistractorTurn[]
  ): UnifiedSession {
    const messages: UnifiedMessage[] = lead.map((turn) => ({
      role: turn.role,
      content: turn.content,
    }))

    for (const turn of distractors) {
      messages.push({
        role: turn.role === "assistant" ? "assistant" : "user",
        content: turn.content,
      })
    }

    return {
      sessionId: `${questionId}-session`,
      messages,
      metadata: { form },
    }
  }

  getQuestions(filter?: QuestionFilter): UnifiedQuestion[] {
    let result = [...this.questions]

    if (filter?.questionTypes?.length) {
      result = result.filter((q) => filter.questionTypes!.includes(q.questionType))
    }

    if (filter?.offset) {
      result = result.slice(filter.offset)
    }

    if (filter?.limit) {
      result = result.slice(0, filter.limit)
    }

    return result
  }

  getHaystackSessions(questionId: string): UnifiedSession[] {
    return this.sessionsMap.get(questionId) || []
  }

  getGroundTruth(questionId: string): string {
    const question = this.questions.find((q) => q.questionId === questionId)
    return question?.groundTruth || ""
  }

  getQuestionTypes(): QuestionTypeRegistry {
    return PREFEVAL_QUESTION_TYPES
  }
}

export default PrefEvalBenchmark
