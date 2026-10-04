import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { factconsolidationQuestions, strideSample } from "./loaders.js";

describe("strideSample", () => {
  const items = Array.from({ length: 100 }, (_, i) => i);

  it("returns everything when the limit is not smaller than the list", () => {
    expect(strideSample(items, 100)).toHaveLength(100);
    expect(strideSample(items, 500)).toHaveLength(100);
    expect(strideSample(items)).toHaveLength(100);
  });

  it("returns exactly the requested count", () => {
    expect(strideSample(items, 10)).toHaveLength(10);
  });

  it("spans the whole list rather than taking its head", () => {
    const sample = strideSample(items, 10);
    expect(sample[0]).toBe(0);
    expect(sample[sample.length - 1]!).toBeGreaterThan(80);
  });

  it("covers every group when the list is grouped, which is the point", () => {
    // Three groups of 100, laid out end to end the way the forms are.
    const grouped = [
      ...Array.from({ length: 100 }, () => "a"),
      ...Array.from({ length: 100 }, () => "b"),
      ...Array.from({ length: 100 }, () => "c"),
    ];
    const sample = strideSample(grouped, 30);
    expect(new Set(sample)).toEqual(new Set(["a", "b", "c"]));
    expect(sample.filter((g) => g === "a")).toHaveLength(10);
  });

  it("returns nothing for a non-positive limit", () => {
    expect(strideSample(items, 0)).toEqual([]);
  });
});

describe("factconsolidationQuestions", () => {
  it("reads query, gold answer, and id from a MemoryAgentBench results file", () => {
    const dir = mkdtempSync(join(tmpdir(), "density-"));
    const path = join(dir, "results.json");
    writeFileSync(
      path,
      JSON.stringify({
        data: [
          {
            query: "Which sport is goaltender associated with?",
            answer: ["pesäpallo"],
            qa_pair_id: "factconsolidation_sh_6k_no0",
          },
        ],
      }),
    );

    const qs = factconsolidationQuestions(path);
    expect(qs).toHaveLength(1);
    expect(qs[0]!.id).toBe("factconsolidation_sh_6k_no0");
    expect(qs[0]!.goldAnswer).toBe("pesäpallo");
    expect(qs[0]!.question).toContain("goaltender");
    expect(qs[0]!.benchmark).toBe("factconsolidation");
  });

  it("throws a clear error when the file has no data array", () => {
    const dir = mkdtempSync(join(tmpdir(), "density-"));
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify({ metrics: {} }));
    expect(() => factconsolidationQuestions(path)).toThrow(/data array/);
  });

  it("keeps an empty gold answer rather than inventing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "density-"));
    const path = join(dir, "empty.json");
    writeFileSync(
      path,
      JSON.stringify({ data: [{ query: "q", answer: [], qa_pair_id: "x" }] }),
    );
    expect(factconsolidationQuestions(path)[0]!.goldAnswer).toBe("");
  });

  it("attaches the same shared context to every question when contextPath is given", () => {
    const dir = mkdtempSync(join(tmpdir(), "density-"));
    const resultsPath = join(dir, "results.json");
    writeFileSync(
      resultsPath,
      JSON.stringify({
        data: [
          { query: "q0", answer: ["a0"], qa_pair_id: "fc-0" },
          { query: "q1", answer: ["a1"], qa_pair_id: "fc-1" },
        ],
      }),
    );
    const contextPath = join(dir, "context.txt");
    writeFileSync(contextPath, "0. fact zero.\n\n1. fact one.\n");

    const qs = factconsolidationQuestions(resultsPath, contextPath);
    expect(qs).toHaveLength(2);
    // Blank lines are dropped, so two facts in, two lines out, on both questions.
    expect(qs[0]!.context).toEqual(["0. fact zero.", "1. fact one."]);
    expect(qs[1]!.context).toEqual(["0. fact zero.", "1. fact one."]);
  });

  it("leaves context empty when contextPath is omitted", () => {
    const dir = mkdtempSync(join(tmpdir(), "density-"));
    const path = join(dir, "results.json");
    writeFileSync(
      path,
      JSON.stringify({ data: [{ query: "q", answer: ["a"], qa_pair_id: "x" }] }),
    );
    expect(factconsolidationQuestions(path)[0]!.context).toEqual([]);
  });
});
