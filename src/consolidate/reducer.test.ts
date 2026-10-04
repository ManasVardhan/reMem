import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DB } from "../db/client.js";
import { HashingEmbedder } from "../embed/index.js";
import { applyOps } from "./reducer.js";
import type { BeliefOp } from "./ops.js";
import {
  listBeliefs,
  getBelief,
  listEdges,
  getProvenanceObservationIds,
} from "../beliefs/store.js";

// The reducer is tested directly with canned op lists. No LLM, no consolidator:
// this isolates the deterministic state logic, which is the safety-critical
// half of "the LLM proposes, the reducer disposes".

describe("reducer (deterministic belief-op application)", () => {
  let db: DB;
  const embedder = new HashingEmbedder({ dim: 32 });

  beforeEach(() => {
    db = openDb();
  });

  afterEach(() => {
    db.close();
  });

  it("CREATE admits a belief above the floor and drops one below", async () => {
    const ops: BeliefOp[] = [
      {
        op: "CREATE",
        kind: "preference",
        predicate: "writing_style",
        value: "concise",
        confidence: 0.8,
        evidence: ["obs-1"],
      },
      {
        op: "CREATE",
        kind: "preference",
        predicate: "coffee",
        value: "oat milk",
        confidence: 0.1, // below default 0.35 floor
        evidence: ["obs-2"],
      },
    ];
    const report = await applyOps(db, embedder, ops);
    expect(report.created).toBe(1);
    expect(report.dropped).toBe(1);

    const beliefs = listBeliefs(db, { status: "active" });
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0]?.predicate).toBe("writing_style");
    expect(beliefs[0]?.value).toBe("concise");
    // Decay rate was stamped from the preference default.
    expect(beliefs[0]?.decayRate).toBeGreaterThan(0);
  });

  it("REINFORCE bumps confidence saturating toward 1 and refreshes ts", async () => {
    const created = await applyOps(db, embedder, [
      {
        op: "CREATE",
        kind: "fact",
        predicate: "home_airport",
        value: "SFO",
        confidence: 0.5,
        evidence: ["obs-1"],
      },
    ]);
    expect(created.created).toBe(1);
    const belief = listBeliefs(db)[0]!;

    await applyOps(
      db,
      embedder,
      [
        {
          op: "REINFORCE",
          beliefId: belief.id,
          delta: 0.5,
          evidence: ["obs-2"],
        },
      ],
      { now: belief.lastReinforcedTs + 1000 },
    );

    const after = getBelief(db, belief.id)!;
    // 1 - (1 - 0.5)(1 - 0.5) = 0.75
    expect(after.confidence).toBeCloseTo(0.75, 6);
    expect(after.lastReinforcedTs).toBe(belief.lastReinforcedTs + 1000);
  });

  it("CONTRADICT supersedes (not deletes) and links via a supersedes edge", async () => {
    await applyOps(db, embedder, [
      {
        op: "CREATE",
        kind: "fact",
        predicate: "home_airport",
        value: "SFO",
        confidence: 0.9,
        evidence: ["obs-1"],
      },
    ]);
    const old = listBeliefs(db)[0]!;

    const report = await applyOps(db, embedder, [
      {
        op: "CONTRADICT",
        beliefId: old.id,
        newValue: "OAK",
        evidence: ["obs-2"],
      },
    ]);
    expect(report.contradicted).toBe(1);

    // Old belief still exists, marked superseded (nothing is deleted).
    const oldAfter = getBelief(db, old.id)!;
    expect(oldAfter.status).toBe("superseded");

    // A single new active belief holds the new value.
    const active = listBeliefs(db, { status: "active" });
    expect(active).toHaveLength(1);
    expect(active[0]?.value).toBe("OAK");
    // It inherited kind and predicate from the contradicted belief.
    expect(active[0]?.kind).toBe("fact");
    expect(active[0]?.predicate).toBe("home_airport");

    // The supersedes edge points new -> old.
    const edges = listEdges(db, { type: "supersedes" });
    expect(edges).toHaveLength(1);
    expect(edges[0]?.srcId).toBe(active[0]?.id);
    expect(edges[0]?.dstId).toBe(old.id);
  });

  it("REFINE narrows scope in place, preserving kind/value", async () => {
    await applyOps(db, embedder, [
      {
        op: "CREATE",
        kind: "preference",
        predicate: "writing_style",
        value: "concise",
        confidence: 0.7,
        evidence: ["obs-1"],
      },
    ]);
    const belief = listBeliefs(db)[0]!;
    expect(belief.scope).toEqual({});

    await applyOps(db, embedder, [
      {
        op: "REFINE",
        beliefId: belief.id,
        narrowerScope: { surface: "slack" },
        evidence: ["obs-2"],
      },
    ]);

    const after = getBelief(db, belief.id)!;
    expect(after.scope).toEqual({ surface: "slack" });
    expect(after.value).toBe("concise");
    expect(after.status).toBe("active");
  });

  it("NOOP changes nothing; unknown belief ids count as invalid", async () => {
    const report = await applyOps(db, embedder, [
      { op: "NOOP", reason: "small talk" },
      { op: "REINFORCE", beliefId: "does-not-exist", delta: 0.2, evidence: [] },
    ]);
    expect(report.nooped).toBe(1);
    expect(report.invalid).toBe(1);
    expect(listBeliefs(db)).toHaveLength(0);
  });

  it("is deterministic: same ops on same start state give the same beliefs", async () => {
    const ops: BeliefOp[] = [
      {
        op: "CREATE",
        kind: "preference",
        predicate: "writing_style",
        value: "concise",
        confidence: 0.8,
        evidence: ["obs-1"],
      },
      {
        op: "CREATE",
        kind: "fact",
        predicate: "home_airport",
        value: "SFO",
        confidence: 0.9,
        evidence: ["obs-2"],
      },
    ];

    const dbA = openDb();
    const dbB = openDb();
    await applyOps(dbA, embedder, ops, { now: 1000 });
    await applyOps(dbB, embedder, ops, { now: 1000 });

    const norm = (b: {
      kind: string;
      predicate: string;
      value: string;
      confidence: number;
      scope: unknown;
      status: string;
    }) => ({
      kind: b.kind,
      predicate: b.predicate,
      value: b.value,
      confidence: b.confidence,
      scope: b.scope,
      status: b.status,
    });

    // Ids are random UUIDs, so compare content sorted by a stable key.
    const byPredicate = (x: { predicate: string }, y: { predicate: string }) =>
      x.predicate.localeCompare(y.predicate);
    const a = listBeliefs(dbA).map(norm).sort(byPredicate);
    const b = listBeliefs(dbB).map(norm).sort(byPredicate);
    expect(a).toEqual(b);
    dbA.close();
    dbB.close();
  });

  it("reinforces rather than duplicating when the same statement arrives twice", async () => {
    // The same window can be consolidated more than once: a session pass and an
    // incremental pass overlap, or an interrupted run is retried. Two rows for
    // one statement would then decay and supersede independently of each other.
    const create = {
      op: "CREATE" as const,
      kind: "preference" as const,
      predicate: "deployment_tool",
      value: "Kamal",
      confidence: 0.8,
      evidence: ["o1"],
    };

    const first = await applyOps(db, embedder, [create]);
    expect(first.created).toBe(1);

    // The same window consolidated again: same statement, same scope.
    const second = await applyOps(db, embedder, [
      { ...create, evidence: ["o2"] },
    ]);
    expect(second.created).toBe(0);
    expect(second.reinforced).toBe(1);

    const held = listBeliefs(db, { status: "active" });
    expect(held).toHaveLength(1);
    expect(held[0]!.confidence).toBeGreaterThan(0.8);

    // Both sightings are on the record as evidence.
    expect(getProvenanceObservationIds(db, held[0]!.id).sort()).toEqual([
      "o1",
      "o2",
    ]);
  });

  it("does not revive a superseded belief by restating it", async () => {
    const created = await applyOps(db, embedder, [
      {
        op: "CREATE",
        kind: "preference",
        predicate: "editor",
        value: "vim",
        confidence: 0.8,
        evidence: ["o1"],
      },
    ]);
    expect(created.created).toBe(1);
    const old = listBeliefs(db, { status: "active" })[0]!;

    await applyOps(db, embedder, [
      {
        op: "CONTRADICT",
        beliefId: old.id,
        newValue: "emacs",
        confidence: 0.9,
        evidence: ["o2"],
      },
    ]);

    // vim lost to a specific successor. Saying it again makes a new belief that
    // can supersede emacs in turn, rather than quietly un-superseding the old
    // row.
    const again = await applyOps(db, embedder, [
      {
        op: "CREATE",
        kind: "preference",
        predicate: "editor",
        value: "vim",
        confidence: 0.85,
        evidence: ["o3"],
      },
    ]);
    expect(again.created).toBe(1);
    expect(
      listBeliefs(db, { status: "superseded" }).find((b) => b.id === old.id),
    ).toBeDefined();
  });

  it("keeps the same statement made in two projects as two beliefs", async () => {
    // Folding these together would leave one belief scoped to whichever project
    // said it first, and it would then be invisible in the other one: the
    // statement would vanish from the project it was actually made in.
    const base = {
      op: "CREATE" as const,
      kind: "preference" as const,
      predicate: "deployment_tool",
      value: "Kamal",
      confidence: 0.8,
    };

    await applyOps(db, embedder, [
      { ...base, evidence: ["o1"], scope: { project: "alpha" } },
    ]);
    const second = await applyOps(db, embedder, [
      { ...base, evidence: ["o2"], scope: { project: "beta" } },
    ]);

    expect(second.created).toBe(1);
    const held = listBeliefs(db, { status: "active" });
    expect(held).toHaveLength(2);
    expect(held.map((b) => b.scope.project).sort()).toEqual(["alpha", "beta"]);
  });

  it("does not let a preference reinforce a fact", async () => {
    // Kinds carry different decay rates, so merging across them would silently
    // change how fast a belief fades.
    const base = {
      op: "CREATE" as const,
      predicate: "database",
      value: "SQLite",
      confidence: 0.8,
      evidence: ["o1"],
    };
    await applyOps(db, embedder, [{ ...base, kind: "fact" as const }]);
    const second = await applyOps(db, embedder, [
      { ...base, kind: "preference" as const, evidence: ["o2"] },
    ]);

    expect(second.created).toBe(1);
    expect(listBeliefs(db, { status: "active" })).toHaveLength(2);
  });
});
