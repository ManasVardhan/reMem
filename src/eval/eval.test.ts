import { describe, it, expect } from "vitest";
import { HashingEmbedder } from "../embed/index.js";
import { syntheticDataset, fixtureConsolidator } from "./fixtures.js";
import {
  ReMemSystem,
  FullContextSystem,
  NaiveVectorSystem,
  NoMemorySystem,
} from "./systems.js";
import { runEval, type SystemMetrics } from "./runner.js";
import { renderReport } from "./report.js";
import { loadExternalDataset } from "./datasets.js";
import {
  abstentionCounts,
  isGrounded,
  precision,
  recall,
  recallAtK,
  reciprocalRank,
} from "./metrics.js";
import type { EvalCase, Retrieval } from "./types.js";

const embedder = new HashingEmbedder();

function systems() {
  return [
    new NoMemorySystem(),
    new FullContextSystem(),
    new NaiveVectorSystem(embedder),
    new ReMemSystem(embedder, fixtureConsolidator),
  ];
}

function bySystem(results: SystemMetrics[]): Record<string, SystemMetrics> {
  return Object.fromEntries(results.map((r) => [r.system, r]));
}

describe("metrics", () => {
  const gold = ["a", "b"];

  it("recallAtK is a hit only within the cutoff", () => {
    expect(recallAtK(["x", "a"], gold, 2)).toBe(1);
    expect(recallAtK(["x", "a"], gold, 1)).toBe(0);
    expect(recallAtK(["x", "y"], gold, 5)).toBe(0);
  });

  it("reciprocalRank rewards the first gold position", () => {
    expect(reciprocalRank(["a"], gold)).toBe(1);
    expect(reciprocalRank(["x", "b"], gold)).toBe(0.5);
    expect(reciprocalRank(["x", "y"], gold)).toBe(0);
  });

  it("grounding an answerable case needs the top hit to be gold", () => {
    const answerable: EvalCase = {
      id: "c",
      ability: "extraction",
      observations: [],
      query: "q",
      context: {},
      goldObservationIds: ["a"],
      answerable: true,
    };
    const hit: Retrieval = {
      rankedObservationIds: ["a"],
      contextTokens: 0,
      abstain: false,
    };
    const miss: Retrieval = {
      rankedObservationIds: ["x", "a"],
      contextTokens: 0,
      abstain: false,
    };
    expect(isGrounded(answerable, hit)).toBe(true);
    expect(isGrounded(answerable, miss)).toBe(false);
  });

  it("grounding an unanswerable case means abstaining", () => {
    const unanswerable: EvalCase = {
      id: "c",
      ability: "abstention",
      observations: [],
      query: "q",
      context: {},
      goldObservationIds: [],
      answerable: false,
    };
    const abstained: Retrieval = {
      rankedObservationIds: [],
      contextTokens: 0,
      abstain: true,
    };
    const guessed: Retrieval = {
      rankedObservationIds: ["x"],
      contextTokens: 0,
      abstain: false,
    };
    expect(isGrounded(unanswerable, abstained)).toBe(true);
    expect(isGrounded(unanswerable, guessed)).toBe(false);
  });

  it("abstention precision and recall react to guesses and misses", () => {
    const unanswerable: EvalCase = {
      id: "c",
      ability: "abstention",
      observations: [],
      query: "q",
      context: {},
      goldObservationIds: [],
      answerable: false,
    };
    const answerable: EvalCase = { ...unanswerable, answerable: true };

    const guessed = abstentionCounts(unanswerable, {
      rankedObservationIds: ["x"],
      contextTokens: 0,
      abstain: false,
    });
    expect(guessed.falseNegative).toBe(1);
    expect(recall(guessed)).toBe(0);

    const overAbstained = abstentionCounts(answerable, {
      rankedObservationIds: [],
      contextTokens: 0,
      abstain: true,
    });
    expect(overAbstained.falsePositive).toBe(1);
    expect(precision(overAbstained)).toBe(0);
  });
});

describe("runner over the synthetic dataset", () => {
  it("produces a structured report for every system", async () => {
    const report = await runEval(syntheticDataset(), systems());
    expect(report.dataset).toBe("reMem-synthetic-v1");
    expect(report.systems.map((s) => s.system)).toEqual([
      "no-memory",
      "full-context",
      "naive-vector",
      "reMem",
    ]);
    for (const s of report.systems) {
      expect(s.cases).toBe(4);
      expect(s.byAbility.length).toBeGreaterThan(0);
    }
  });

  it("no-memory is the token floor and full-context stuffs at least as much as naive vector", async () => {
    const report = await runEval(syntheticDataset(), systems());
    const m = bySystem(report.systems);
    // Abstaining on everything costs nothing.
    expect(m["no-memory"]!.avgContextTokens).toBe(0);
    // Both stuff raw observations; full-context stuffs all of them, naive a
    // top-k subset, so full-context is never cheaper than naive vector.
    expect(m["full-context"]!.avgContextTokens).toBeGreaterThanOrEqual(
      m["naive-vector"]!.avgContextTokens,
    );
  });

  it("no-memory abstains on everything: perfect recall, poor precision", async () => {
    const report = await runEval(syntheticDataset(), systems());
    const noMem = bySystem(report.systems)["no-memory"]!;
    expect(noMem.abstentionRecall).toBe(1);
    expect(noMem.abstentionPrecision).toBeLessThan(1);
  });

  it("reMem matches or beats naive vector on grounded accuracy", async () => {
    const report = await runEval(syntheticDataset(), systems());
    const m = bySystem(report.systems);
    expect(m["reMem"]!.groundedAccuracy).toBeGreaterThanOrEqual(
      m["naive-vector"]!.groundedAccuracy,
    );
  });

  it("reMem wins on knowledge_update and abstention slices", async () => {
    const report = await runEval(syntheticDataset(), systems());
    const m = bySystem(report.systems);
    const slice = (s: SystemMetrics, ability: string) =>
      s.byAbility.find((a) => a.ability === ability)!.groundedAccuracy;

    expect(slice(m["reMem"]!, "knowledge_update")).toBe(1);
    expect(slice(m["reMem"]!, "abstention")).toBe(1);
    // Naive vector cannot abstain, so it loses the abstention slice outright.
    expect(slice(m["naive-vector"]!, "abstention")).toBe(0);
  });
});

describe("report rendering", () => {
  it("renders markdown tables and uses no em dashes", async () => {
    const report = await runEval(syntheticDataset(), systems());
    const md = renderReport(report);
    expect(md).toContain("| System |");
    expect(md).toContain("reMem");
    expect(md).not.toContain("\u2014");
  });
});

describe("external datasets registry", () => {
  it("refuses to load without an explicit opt-in", () => {
    expect(() => loadExternalDataset("longmemeval")).toThrow(/allowExternal/);
  });

  it("throws on an unknown dataset key", () => {
    expect(() => loadExternalDataset("nope")).toThrow(/Unknown external/);
  });
});
