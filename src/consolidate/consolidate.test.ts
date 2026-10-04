import { describe, it, expect } from "vitest";
import { ReMemKernel } from "../kernel.js";
import { FunctionConsolidator } from "./consolidator.js";
import type { BeliefOp } from "./ops.js";
import { getProvenanceObservationIds } from "../beliefs/store.js";

// End-to-end diagnostic evals: observations flow through a scripted consolidator
// and the reducer into beliefs, then we assert the kernel's introspection
// surface. These mirror the internal evals in docs/BENCHMARKS.md section 5.

describe("consolidation pipeline (diagnostic evals)", () => {
  it("contradiction: SFO then a move to OAK yields OAK active, SFO superseded, why() cites both", async () => {
    const kernel = new ReMemKernel({
      consolidator: new FunctionConsolidator(
        ({ observations, relevantBeliefs }) => {
          const ops: BeliefOp[] = [];
          for (const obs of observations) {
            if (/fly out of SFO/i.test(obs.content)) {
              ops.push({
                op: "CREATE",
                kind: "fact",
                predicate: "home_airport",
                value: "SFO",
                confidence: 0.9,
                evidence: [obs.id],
              });
            }
            if (/moved.*fly out of OAK/i.test(obs.content)) {
              const prior = relevantBeliefs.find(
                (b) => b.predicate === "home_airport",
              );
              if (prior) {
                ops.push({
                  op: "CONTRADICT",
                  beliefId: prior.id,
                  newValue: "OAK",
                  evidence: [obs.id],
                });
              }
            }
          }
          return ops;
        },
      ),
    });

    // Explicit timestamps let each consolidation pass window on only the new
    // observations (since), which is how a real always-on kernel runs.
    const o1 = await kernel.observe({
      ts: 1000,
      source: "slack",
      actor: "user",
      content: "I fly out of SFO for work.",
    });
    await kernel.consolidate({ since: 1000 });

    const o2 = await kernel.observe({
      ts: 2000,
      source: "slack",
      actor: "user",
      content: "I moved, I fly out of OAK now.",
    });
    await kernel.consolidate({ since: 2000 });

    const active = kernel.beliefs({
      status: "active",
      predicate: "home_airport",
    });
    expect(active).toHaveLength(1);
    expect(active[0]?.value).toBe("OAK");

    const superseded = kernel.beliefs({
      status: "superseded",
      predicate: "home_airport",
    });
    expect(superseded).toHaveLength(1);
    expect(superseded[0]?.value).toBe("SFO");

    // why() cites the observation behind each belief.
    expect(kernel.why(active[0]!.id).observations.map((o) => o.id)).toContain(
      o2.id,
    );
    expect(
      kernel.why(superseded[0]!.id).observations.map((o) => o.id),
    ).toContain(o1.id);
    kernel.close();
  });

  it("create-floor: a one-off remark below the floor never becomes a belief", async () => {
    const kernel = new ReMemKernel({
      consolidator: new FunctionConsolidator(({ observations }) =>
        observations.map((obs) => ({
          op: "CREATE" as const,
          kind: "preference" as const,
          predicate: "snack",
          value: "pretzels",
          confidence: 0.15, // below floor
          evidence: [obs.id],
        })),
      ),
    });
    await kernel.observe({
      source: "slack",
      actor: "user",
      content: "eh, maybe pretzels once",
    });
    const report = await kernel.consolidate();
    expect(report.dropped).toBe(1);
    expect(kernel.beliefs()).toHaveLength(0);
    kernel.close();
  });

  it("provenance integrity: every active belief resolves to at least one observation", async () => {
    const kernel = new ReMemKernel({
      consolidator: new FunctionConsolidator(({ observations }) =>
        observations.map((obs) => ({
          op: "CREATE" as const,
          kind: "preference" as const,
          predicate: "writing_style",
          value: "concise",
          confidence: 0.8,
          evidence: [obs.id],
        })),
      ),
    });
    await kernel.observe({
      source: "slack",
      actor: "user",
      content: "keep it short please",
    });
    await kernel.consolidate();

    for (const belief of kernel.beliefs({ status: "active" })) {
      const provenance = getProvenanceObservationIds(kernel.raw, belief.id);
      expect(provenance.length).toBeGreaterThanOrEqual(1);
      expect(kernel.why(belief.id).observations.length).toBeGreaterThanOrEqual(
        1,
      );
    }
    kernel.close();
  });

  it("abstention: nothing is believed about a topic that was never observed", async () => {
    const kernel = new ReMemKernel({
      consolidator: new FunctionConsolidator(() => []),
    });
    await kernel.observe({
      source: "slack",
      actor: "user",
      content: "the weather is nice today",
    });
    await kernel.consolidate();
    expect(kernel.beliefs({ predicate: "home_airport" })).toHaveLength(0);
    expect(kernel.beliefs()).toHaveLength(0);
    kernel.close();
  });

  it("reinforce: repeated agreement raises confidence over multiple passes", async () => {
    const kernel = new ReMemKernel({
      consolidator: new FunctionConsolidator(
        ({ observations, relevantBeliefs }) => {
          const existing = relevantBeliefs.find(
            (b) => b.predicate === "writing_style",
          );
          const obs = observations[observations.length - 1];
          if (!obs) return [];
          if (existing) {
            return [
              {
                op: "REINFORCE",
                beliefId: existing.id,
                delta: 0.4,
                evidence: [obs.id],
              },
            ];
          }
          return [
            {
              op: "CREATE",
              kind: "preference",
              predicate: "writing_style",
              value: "concise",
              confidence: 0.5,
              evidence: [obs.id],
            },
          ];
        },
      ),
    });

    await kernel.observe({
      source: "slack",
      actor: "user",
      content: "be brief",
    });
    await kernel.consolidate();
    const first = kernel.beliefs({ predicate: "writing_style" })[0]!;
    expect(first.confidence).toBeCloseTo(0.5, 6);

    await kernel.observe({
      source: "slack",
      actor: "user",
      content: "shorter",
    });
    await kernel.consolidate();
    const second = kernel.beliefs({ predicate: "writing_style" })[0]!;
    // 1 - (1 - 0.5)(1 - 0.4) = 0.7
    expect(second.confidence).toBeCloseTo(0.7, 6);
    kernel.close();
  });

  it("consolidate() throws when no consolidator is configured", async () => {
    const kernel = new ReMemKernel();
    await expect(kernel.consolidate()).rejects.toThrow(/consolidator/);
    kernel.close();
  });
});
