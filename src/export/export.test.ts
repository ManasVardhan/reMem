import { describe, it, expect } from "vitest";
import { ReMemKernel } from "../kernel.js";
import { FunctionConsolidator } from "../consolidate/consolidator.js";
import { SNAPSHOT_VERSION } from "./index.js";

function contradictingConsolidator(): FunctionConsolidator {
  // First pass: create a belief. Second pass: contradict it, producing a
  // superseded belief + a supersedes edge, so the snapshot exercises every
  // table.
  let pass = 0;
  return new FunctionConsolidator(({ observations, relevantBeliefs }) => {
    pass++;
    if (pass === 1) {
      return observations.map((obs) => ({
        op: "CREATE" as const,
        kind: "fact" as const,
        predicate: "home_airport",
        value: "SFO",
        confidence: 0.9,
        evidence: [obs.id],
      }));
    }
    const target = relevantBeliefs[0];
    if (!target) return [];
    return observations.map((obs) => ({
      op: "CONTRADICT" as const,
      beliefId: target.id,
      newValue: "OAK",
      evidence: [obs.id],
    }));
  });
}

describe("export (sovereignty snapshot)", () => {
  it("emits a complete, JSON-serializable snapshot of every table", async () => {
    const kernel = new ReMemKernel({
      consolidator: contradictingConsolidator(),
    });
    const obs1 = await kernel.observe({
      source: "email",
      actor: "user",
      content: "I fly out of SFO",
      ts: 1000,
    });
    await kernel.consolidate();
    const obs2 = await kernel.observe({
      source: "email",
      actor: "user",
      content: "actually I use OAK now",
      ts: 2000,
    });
    await kernel.consolidate({ since: 2000 });

    const snapshot = await kernel.export();

    expect(snapshot.version).toBe(SNAPSHOT_VERSION);
    // Ledger holds both observations.
    expect(snapshot.observations.map((o) => o.id).sort()).toEqual(
      [obs1.id, obs2.id].sort(),
    );
    // One active (OAK) + one superseded (SFO).
    expect(snapshot.beliefs).toHaveLength(2);
    expect(snapshot.beliefs.filter((b) => b.status === "active")).toHaveLength(
      1,
    );
    expect(
      snapshot.beliefs.filter((b) => b.status === "superseded"),
    ).toHaveLength(1);
    // The supersedes edge is present.
    expect(snapshot.edges.some((e) => e.type === "supersedes")).toBe(true);
    // Provenance links exist for the beliefs.
    expect(snapshot.provenance.length).toBeGreaterThan(0);
    // Embeddings serialized as plain arrays (JSON round-trips cleanly).
    expect(Array.isArray(snapshot.beliefs[0]?.embedding)).toBe(true);
    expect(() => JSON.stringify(snapshot)).not.toThrow();

    kernel.close();
  });

  it("returns empty collections for a fresh kernel", async () => {
    const kernel = new ReMemKernel();
    const snapshot = await kernel.export();
    expect(snapshot.observations).toHaveLength(0);
    expect(snapshot.beliefs).toHaveLength(0);
    expect(snapshot.edges).toHaveLength(0);
    expect(snapshot.provenance).toHaveLength(0);
    kernel.close();
  });
});
