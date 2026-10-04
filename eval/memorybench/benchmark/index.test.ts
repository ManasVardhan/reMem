import { describe, it, expect, beforeAll } from "bun:test"
import { PrefEvalBenchmark, PREFEVAL_QUESTION_TYPES } from "./index"
import { getJudgePromptForType, PREFERENCE_JUDGE_PROMPT } from "../../prompts/defaults"

describe("PrefEvalBenchmark", () => {
  let benchmark: PrefEvalBenchmark

  beforeAll(async () => {
    benchmark = new PrefEvalBenchmark()
    await benchmark.load()
  })

  it("loads all three forms and produces questions for each", () => {
    const questions = benchmark.getQuestions()
    expect(questions.length).toBeGreaterThan(0)

    for (const type of Object.keys(PREFEVAL_QUESTION_TYPES)) {
      const forType = benchmark.getQuestions({ questionTypes: [type] })
      expect(forType.length).toBeGreaterThan(0)
    }
  })

  it("gives every question a type prefixed with preference- that routes to the preference judge", () => {
    const questions = benchmark.getQuestions()
    expect(questions.length).toBeGreaterThan(0)

    const seenTypes = new Set(questions.map((q) => q.questionType))
    expect(seenTypes.size).toBe(3)

    for (const type of seenTypes) {
      expect(type.startsWith("preference-")).toBe(true)
      expect(getJudgePromptForType(type)).toBe(PREFERENCE_JUDGE_PROMPT)
    }
  })

  it("returns the preference statement as ground truth, not an answer string", () => {
    const [question] = benchmark.getQuestions({ questionTypes: ["preference-explicit"], limit: 1 })
    expect(question).toBeDefined()

    const groundTruth = benchmark.getGroundTruth(question!.questionId)
    expect(groundTruth).toBe(question!.groundTruth)
    // The ground truth is the standing preference, never the literal answer to
    // the final question.
    expect(groundTruth).not.toBe(question!.question)
    expect(groundTruth.length).toBeGreaterThan(0)
  })

  it("returns an empty string for an unknown question id", () => {
    expect(benchmark.getGroundTruth("does-not-exist")).toBe("")
  })

  describe("haystack sessions", () => {
    it("include both the preference turn and the distractors, in original order, for explicit", () => {
      const [question] = benchmark.getQuestions({
        questionTypes: ["preference-explicit"],
        limit: 1,
      })
      const sessions = benchmark.getHaystackSessions(question!.questionId)
      expect(sessions.length).toBe(1)

      const messages = sessions[0]!.messages
      const preferenceIndex = messages.findIndex((m) => m.content === question!.groundTruth)
      expect(preferenceIndex).toBe(0)
      // Distractors follow the preference turn; there must be more than one
      // message, or the distractor pool silently failed to load.
      expect(messages.length).toBeGreaterThan(1)
    })

    it("preserve the native four-turn order for choice-based instances", () => {
      const [question] = benchmark.getQuestions({
        questionTypes: ["preference-choice-based"],
        limit: 1,
      })
      const sessions = benchmark.getHaystackSessions(question!.questionId)
      const messages = sessions[0]!.messages

      // query, options, selection, acknowledgment: alternating user/assistant,
      // not the gold (selection) turn hoisted to the front.
      expect(messages[0]!.role).toBe("user")
      expect(messages[1]!.role).toBe("assistant")
      expect(messages[2]!.role).toBe("user")
      expect(messages[3]!.role).toBe("assistant")
      expect(messages.length).toBeGreaterThan(4)
    })

    it("preserve the native persona conversation order across all turns", () => {
      const [question] = benchmark.getQuestions({
        questionTypes: ["preference-persona-driven"],
        limit: 1,
      })
      const sessions = benchmark.getHaystackSessions(question!.questionId)
      const messages = sessions[0]!.messages

      expect(messages.length).toBeGreaterThan(2)
      // Persona turns alternate user/assistant starting with user, and appear
      // before any distractor content.
      expect(messages[0]!.role).toBe("user")
      expect(messages[1]!.role).toBe("assistant")
    })

    it("returns an empty array for an unknown question id", () => {
      expect(benchmark.getHaystackSessions("does-not-exist")).toEqual([])
    })
  })

  describe("getQuestions filtering", () => {
    it("filters by questionTypes", () => {
      const explicitOnly = benchmark.getQuestions({ questionTypes: ["preference-explicit"] })
      expect(explicitOnly.length).toBeGreaterThan(0)
      expect(explicitOnly.every((q) => q.questionType === "preference-explicit")).toBe(true)
    })

    it("respects limit and offset", () => {
      const all = benchmark.getQuestions({ questionTypes: ["preference-explicit"] })
      const limited = benchmark.getQuestions({
        questionTypes: ["preference-explicit"],
        limit: 5,
      })
      expect(limited.length).toBe(5)
      expect(limited).toEqual(all.slice(0, 5))

      const offset = benchmark.getQuestions({
        questionTypes: ["preference-explicit"],
        offset: 5,
        limit: 5,
      })
      expect(offset).toEqual(all.slice(5, 10))
    })
  })

  it("exposes a question type registry describing all three forms", () => {
    const registry = benchmark.getQuestionTypes()
    expect(Object.keys(registry).sort()).toEqual(
      ["preference-choice-based", "preference-explicit", "preference-persona-driven"].sort()
    )
  })
})
