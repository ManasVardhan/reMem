import type { ProviderPrompts } from "../../types/prompts"

interface ReMemSearchResult {
  id: string
  memory: string
  score: number
  created_at?: string | null
  confidence?: number | null
  evidence_count?: number | null
  status?: string | null
}

/**
 * Render reMem results as readable lines rather than raw JSON.
 *
 * Without this the harness falls back to `buildContextString`, which is
 * `JSON.stringify(context, null, 2)`. That hands the answering model a UUID, a
 * float score, and three null fields per result, pretty-printed, ten times per
 * question. Measured on LoCoMo that was 1,212 context tokens for 119 characters
 * of actual content per slot, against mem0's 549 tokens for 164 characters. The
 * scaffolding cost more than the memories.
 *
 * Dates are rendered because reMem carries the observation's own event time,
 * and time-ordered questions cannot be answered without it. Confidence is shown
 * only when present, which is the case for beliefs and not for raw
 * observations, so an absent value is never rendered as "null".
 */
function buildReMemContext(context: unknown[]): string {
  const results = context as ReMemSearchResult[]

  if (results.length === 0) {
    return "No relevant memories were retrieved."
  }

  return results
    .map((r, i) => {
      const date = r.created_at ? ` [${String(r.created_at).slice(0, 10)}]` : ""
      const confidence =
        typeof r.confidence === "number" ? ` (belief, confidence ${r.confidence.toFixed(2)})` : ""
      return `[${i + 1}]${date}${confidence} ${r.memory}`
    })
    .join("\n\n")
}

export function buildReMemAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string
): string {
  const memories = buildReMemContext(context)
  const dateLine = questionDate ? `\nToday's date: ${questionDate}\n` : ""

  return `You are answering a question using memories retrieved from a conversation history.

Each memory is prefixed with its index and, where known, the date the exchange happened. Entries marked as beliefs are consolidated statements about the person rather than verbatim turns.

Instructions:
- Use only the memories below. Do not invent facts.
- Resolve relative time references ("yesterday", "last week") against the memory's own date.
- When memories conflict, prefer the most recent one.
- If the memories do not contain the answer, say "I don't know".
- Answer concisely.
${dateLine}
Memories:

${memories}

Question: ${question}

Answer:`
}

export const REMEM_PROMPTS: ProviderPrompts = {
  answerPrompt: buildReMemAnswerPrompt,
}

export default REMEM_PROMPTS
