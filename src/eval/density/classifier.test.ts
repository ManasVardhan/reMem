import { describe, expect, it } from "vitest";
import type { ChatCompleter } from "../../consolidate/llm.js";
import { classifyAll, classifyQuestion, parseVerdict } from "./classifier.js";
import type { DensityQuestion } from "./types.js";

const question: DensityQuestion = {
  id: "q1",
  benchmark: "test",
  question: "Where does Alice live now?",
  goldAnswer: "Seattle",
  context: ["Alice lives in Boston.", "Alice moved to Seattle."],
};

function cannedCompleter(reply: string): ChatCompleter {
  return async () => reply;
}

describe("parseVerdict", () => {
  it("reads a well-formed contradiction verdict", () => {
    const v = parseVerdict(
      '{"label":"contradiction","evidence":["Alice lives in Boston.","Alice moved to Seattle."]}',
      "q1",
    );
    expect(v.label).toBe("contradiction");
    expect(v.evidence).toHaveLength(2);
  });

  it("downgrades a contradiction claim that supplies no evidence pair", () => {
    const v = parseVerdict('{"label":"contradiction","evidence":[]}', "q1");
    expect(v.label).toBe("no-contradiction");
  });

  it("downgrades a contradiction claim with only one evidence item", () => {
    const v = parseVerdict('{"label":"contradiction","evidence":["only one"]}', "q1");
    expect(v.label).toBe("no-contradiction");
  });

  it("defaults to no-contradiction on malformed JSON", () => {
    const v = parseVerdict("not json at all", "q1");
    expect(v.label).toBe("no-contradiction");
    expect(v.evidence).toEqual([]);
  });

  it("tolerates a fenced code block around the JSON", () => {
    const raw = '```json\n{"label":"contradiction","evidence":["a","b"]}\n```';
    expect(parseVerdict(raw, "q1").label).toBe("contradiction");
  });

  it("downgrades when evidence is not an array", () => {
    expect(parseVerdict('{"label":"contradiction","evidence":"a and b"}', "q1").label).toBe(
      "no-contradiction",
    );
  });

  it("downgrades when evidence items are not strings", () => {
    expect(parseVerdict('{"label":"contradiction","evidence":[1,2]}', "q1").label).toBe(
      "no-contradiction",
    );
  });

  it("treats an unrecognised label as no-contradiction", () => {
    expect(parseVerdict('{"label":"maybe","evidence":["a","b"]}', "q1").label).toBe(
      "no-contradiction",
    );
  });
});

describe("classifyQuestion", () => {
  it("returns the parsed verdict with the question id", async () => {
    const complete = cannedCompleter(
      '{"label":"contradiction","evidence":["Alice lives in Boston.","Alice moved to Seattle."]}',
    );
    const v = await classifyQuestion(complete, question);
    expect(v.id).toBe("q1");
    expect(v.label).toBe("contradiction");
  });

  it("sends the question, gold answer, and every context line to the model", async () => {
    let seen = "";
    const complete: ChatCompleter = async (messages) => {
      seen = messages.map((m) => m.content).join("\n");
      return '{"label":"no-contradiction","evidence":[]}';
    };
    await classifyQuestion(complete, question);
    expect(seen).toContain("Where does Alice live now?");
    expect(seen).toContain("Seattle");
    expect(seen).toContain("Alice lives in Boston.");
    expect(seen).toContain("Alice moved to Seattle.");
  });

  it("labels no-contradiction when the model says so", async () => {
    const v = await classifyQuestion(
      cannedCompleter('{"label":"no-contradiction","evidence":[]}'),
      question,
    );
    expect(v.label).toBe("no-contradiction");
  });

  it("downgrades a contradiction whose later quote lacks the gold answer", async () => {
    const complete = cannedCompleter(
      '{"label":"contradiction","evidence":["Alice lives in Boston.","Alice bought a bicycle."]}',
    );
    expect((await classifyQuestion(complete, question)).label).toBe("no-contradiction");
  });

  it("keeps a contradiction whose later quote contains the gold answer", async () => {
    const complete = cannedCompleter(
      '{"label":"contradiction","evidence":["Alice lives in Boston.","Alice moved to Seattle."]}',
    );
    expect((await classifyQuestion(complete, question)).label).toBe("contradiction");
  });
});

describe("classifyAll", () => {
  it("returns one verdict per question, in input order", async () => {
    const qs: DensityQuestion[] = [
      { ...question, id: "a" },
      { ...question, id: "b" },
      { ...question, id: "c" },
    ];
    const verdicts = await classifyAll(
      cannedCompleter('{"label":"no-contradiction","evidence":[]}'),
      qs,
    );
    expect(verdicts.map((v) => v.id)).toEqual(["a", "b", "c"]);
  });

  it("records a failed call as no-contradiction rather than throwing", async () => {
    const complete: ChatCompleter = async () => {
      throw new Error("rate limited");
    };
    const verdicts = await classifyAll(complete, [question]);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.label).toBe("no-contradiction");
  });

  it("marks a failed call so a half-failed sweep is visible", async () => {
    const complete: ChatCompleter = async () => {
      throw new Error("rate limited");
    };
    const verdicts = await classifyAll(complete, [question]);
    expect(verdicts[0]!.failed).toBe(true);
  });

  it("does not mark a successful call as failed", async () => {
    const verdicts = await classifyAll(
      cannedCompleter('{"label":"no-contradiction","evidence":[]}'),
      [question],
    );
    expect(verdicts[0]!.failed).toBe(false);
  });
});
