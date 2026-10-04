import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DB } from "../db/client.js";
import { HashingEmbedder } from "../embed/index.js";
import { applyOps } from "../consolidate/reducer.js";
import { listBeliefs, getBelief } from "../beliefs/store.js";
import { decayRateFor } from "../beliefs/rates.js";
import { effectiveConfidence, runDecay } from "./index.js";
import { ReMemKernel } from "../kernel.js";
import { FunctionConsolidator } from "../consolidate/consolidator.js";

const MS_PER_DAY = 86_400_000;
const embedder = new HashingEmbedder({ dim: 32 });

describe("decay (deterministic time-discounted confidence)", () => {
  let db: DB;

  beforeEach(() => {
    db = openDb();
  });

  afterEach(() => {
    db.close();
  });

  it("halves confidence after exactly one half-life", async () => {
    await applyOps(
      db,
      embedder,
      [
        {
          op: "CREATE",
          kind: "preference",
          predicate: "writing_style",
          value: "concise",
          confidence: 0.8,
          evidence: ["obs-1"],
        },
      ],
      { now: 0 },
    );
    const belief = listBeliefs(db)[0]!;
    // preference half-life is 60 days; at exactly that dt the multiplier is 0.5.
    const halfLifeMs = Math.LN2 / decayRateFor("preference");
    expect(effectiveConfidence(belief, halfLifeMs)).toBeCloseTo(0.4, 6);
    // At creation time there is no decay yet.
    expect(effectiveConfidence(belief, 0)).toBeCloseTo(0.8, 6);
  });

  it("never exceeds base confidence under clock skew", async () => {
    await applyOps(
      db,
      embedder,
      [
        {
          op: "CREATE",
          kind: "fact",
          predicate: "home_airport",
          value: "SFO",
          confidence: 0.6,
          evidence: ["obs-1"],
        },
      ],
      { now: 1000 },
    );
    const belief = listBeliefs(db)[0]!;
    // now earlier than lastReinforcedTs: dt clamps to 0.
    expect(effectiveConfidence(belief, 0)).toBeCloseTo(0.6, 6);
  });

  it("archives a decayed belief and leaves a fresh one active", async () => {
    await applyOps(
      db,
      embedder,
      [
        {
          op: "CREATE",
          kind: "preference",
          predicate: "snack",
          value: "pretzels",
          confidence: 0.5,
          evidence: ["obs-old"],
        },
      ],
      { now: 0 },
    );
    // A second, fresh belief created 400 days later.
    const freshNow = 400 * MS_PER_DAY;
    await applyOps(
      db,
      embedder,
      [
        {
          op: "CREATE",
          kind: "preference",
          predicate: "writing_style",
          value: "concise",
          confidence: 0.9,
          evidence: ["obs-new"],
        },
      ],
      { now: freshNow },
    );

    const report = runDecay(db, { now: freshNow });
    expect(report.scanned).toBe(2);
    expect(report.archived).toBe(1);

    const active = listBeliefs(db, { status: "active" });
    expect(active.map((b) => b.predicate)).toEqual(["writing_style"]);
    const archived = listBeliefs(db, { status: "archived" });
    expect(archived.map((b) => b.predicate)).toEqual(["snack"]);
  });

  it("does not archive superseded beliefs (they are history, not active)", async () => {
    await applyOps(
      db,
      embedder,
      [
        {
          op: "CREATE",
          kind: "fact",
          predicate: "home_airport",
          value: "SFO",
          confidence: 0.9,
          evidence: ["obs-1"],
        },
      ],
      { now: 0 },
    );
    const old = listBeliefs(db)[0]!;
    await applyOps(
      db,
      embedder,
      [
        {
          op: "CONTRADICT",
          beliefId: old.id,
          newValue: "OAK",
          evidence: ["obs-2"],
        },
      ],
      { now: 0 },
    );

    // Even far in the future, decay only scans active beliefs.
    const report = runDecay(db, { now: 100_000 * MS_PER_DAY });
    // Only the active OAK belief is scanned; SFO is superseded and skipped.
    expect(getBelief(db, old.id)?.status).toBe("superseded");
    expect(report.scanned).toBe(1);
  });

  it("reinforcement revives an archived belief (forgetting is reversible)", async () => {
    await applyOps(
      db,
      embedder,
      [
        {
          op: "CREATE",
          kind: "preference",
          predicate: "writing_style",
          value: "concise",
          confidence: 0.5,
          evidence: ["obs-1"],
        },
      ],
      { now: 0 },
    );
    const belief = listBeliefs(db)[0]!;
    runDecay(db, { now: 400 * MS_PER_DAY });
    expect(getBelief(db, belief.id)?.status).toBe("archived");

    // New agreeing evidence arrives; the belief comes back.
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
      { now: 400 * MS_PER_DAY },
    );
    expect(getBelief(db, belief.id)?.status).toBe("active");
  });
});

describe("forget (explicit user erasure)", () => {
  it("removes a belief but leaves the ledger observations intact", async () => {
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
    const obs = await kernel.observe({
      source: "slack",
      actor: "user",
      content: "keep it short",
    });
    await kernel.consolidate();
    const belief = kernel.beliefs()[0]!;

    await kernel.forget(belief.id);

    // Belief is gone across all statuses.
    expect(kernel.beliefs({})).toHaveLength(0);
    expect(() => kernel.why(belief.id)).toThrow(/unknown belief/);
    // The observation that justified it is still in the ledger.
    expect(kernel.observation(obs.id)?.content).toBe("keep it short");
    kernel.close();
  });

  it("throws when forgetting a belief that does not exist", async () => {
    const kernel = new ReMemKernel();
    await expect(kernel.forget("nope")).rejects.toThrow(/unknown belief/);
    kernel.close();
  });
});
