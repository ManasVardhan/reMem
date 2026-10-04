import { describe, it, expect } from "vitest";
import { Bm25Index, tokenize } from "./bm25.js";

describe("BM25 keyword ranking", () => {
  it("tokenizes on non-alphanumeric boundaries, lowercased", () => {
    expect(tokenize("Home-Airport: SFO!")).toEqual(["home", "airport", "sfo"]);
  });

  it("ranks the document containing the query term highest", () => {
    const index = new Bm25Index([
      { id: "a", text: "preference writing_style concise" },
      { id: "b", text: "fact home_airport sfo" },
      { id: "c", text: "goal learn spanish" },
    ]);
    const scores = index.scoreAll("airport");
    expect(scores.get("b")! > 0).toBe(true);
    expect(scores.get("a")).toBe(0);
    expect(scores.get("c")).toBe(0);
  });

  it("scores a document with no query term at zero", () => {
    const index = new Bm25Index([{ id: "a", text: "totally unrelated text" }]);
    expect(index.score("a", tokenize("airport flight seat"))).toBe(0);
  });

  it("rewards rarer terms more (idf)", () => {
    // 'common' appears in every doc; 'rare' in one. A doc matching 'rare'
    // should outscore one matching only 'common'.
    const index = new Bm25Index([
      { id: "a", text: "common rare token" },
      { id: "b", text: "common filler token" },
      { id: "c", text: "common filler token" },
    ]);
    const rareScore = index.score("a", ["rare"]);
    const commonScore = index.score("b", ["common"]);
    expect(rareScore > commonScore).toBe(true);
  });

  it("returns an empty-safe result for an empty corpus", () => {
    const index = new Bm25Index([]);
    expect(index.scoreAll("anything").size).toBe(0);
  });
});
