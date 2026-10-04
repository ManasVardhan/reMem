import { describe, expect, it } from "vitest";
import { exactDensity, parseSerialFacts, prefixFor } from "./factconsolidation.js";
import type { DensityQuestion } from "./types.js";

// Five real lines from factconsolidation_sh_6k, serials preserved. Lines 223
// and 310 are a genuine superseding pair. Lines 59 and 261 are a second pair,
// and they also make "pesäpallo" appear as a subject as well as an answer,
// which is the collision the prefix rule has to survive.
const CONTEXT = `Here is a list of facts:
59. pesäpallo was created in the country of Finland.
169. Lisa Leslie plays the position of goaltender.
223. goaltender is associated with the sport of ice hockey.
261. pesäpallo was created in the country of Philippines.
310. goaltender is associated with the sport of pesäpallo.`;

function q(id: string, question: string, goldAnswer: string): DensityQuestion {
  return { id, benchmark: "fc", question, goldAnswer, context: [] };
}

describe("parseSerialFacts", () => {
  it("reads the serial and the sentence from each numbered line", () => {
    const facts = parseSerialFacts(CONTEXT);
    expect(facts).toHaveLength(5);
    expect(facts[0]).toEqual({
      serial: 59,
      text: "pesäpallo was created in the country of Finland.",
    });
  });

  it("ignores the unnumbered header line", () => {
    expect(parseSerialFacts(CONTEXT).some((f) => f.text.includes("Here is a list"))).toBe(
      false,
    );
  });

  it("preserves non-ASCII values", () => {
    const facts = parseSerialFacts(CONTEXT);
    expect(facts.some((f) => f.text.includes("pesäpallo"))).toBe(true);
  });
});

describe("prefixFor", () => {
  it("strips a trailing value and its full stop", () => {
    expect(prefixFor("goaltender is associated with the sport of pesäpallo.", "pesäpallo")).toBe(
      "goaltender is associated with the sport of ",
    );
  });

  it("is case insensitive on the value", () => {
    expect(prefixFor("Hines Ward plays the position of wide receiver.", "Wide Receiver")).toBe(
      "hines ward plays the position of ",
    );
  });

  it("returns null when the sentence does not end with the value", () => {
    expect(prefixFor("pesäpallo was created in the country of Finland.", "pesäpallo")).toBeNull();
  });

  it("returns null for an empty value", () => {
    expect(prefixFor("anything at all.", "")).toBeNull();
  });
});

describe("exactDensity", () => {
  const facts = parseSerialFacts(CONTEXT);

  it("counts a question whose prefix carries two different endings", () => {
    const report = exactDensity(
      [q("q1", "Which sport is goaltender associated with?", "pesäpallo")],
      facts,
      "fc",
    );
    expect(report.contradictions).toBe(1);
    expect(report.density).toBe(1);
    expect(report.failures).toBe(0);
  });

  it("does not count a question whose prefix carries one ending", () => {
    const report = exactDensity(
      [q("q2", "What position does Lisa Leslie play?", "goaltender")],
      facts,
      "fc",
    );
    expect(report.contradictions).toBe(0);
  });

  it("does not let a value that is also a subject create a false contradiction", () => {
    // "goaltender" ends line 169 only. It is the SUBJECT of 223 and 310, which
    // a subject-token match would wrongly treat as the same predicate.
    const report = exactDensity(
      [q("q3", "What position does Lisa Leslie play?", "goaltender")],
      facts,
      "fc",
    );
    expect(report.contradictions).toBe(0);
  });

  it("counts a gold answer that matches no fact as unscoreable, not as a negative", () => {
    const report = exactDensity([q("q4", "Who is nobody?", "Atlantis")], facts, "fc");
    expect(report.failures).toBe(1);
    expect(report.contradictions).toBe(0);
  });

  it("reports a Wilson interval bracketing the point estimate", () => {
    const report = exactDensity(
      [
        q("a", "Which sport is goaltender associated with?", "pesäpallo"),
        q("b", "What position does Lisa Leslie play?", "goaltender"),
      ],
      facts,
      "fc",
    );
    expect(report.n).toBe(2);
    expect(report.ci95[0]).toBeLessThanOrEqual(report.density);
    expect(report.ci95[1]).toBeGreaterThanOrEqual(report.density);
  });
});
