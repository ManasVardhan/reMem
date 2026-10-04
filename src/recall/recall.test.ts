import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DB } from "../db/client.js";
import { HashingEmbedder } from "../embed/index.js";
import { applyOps } from "../consolidate/reducer.js";
import { listBeliefs, addEdge } from "../beliefs/store.js";
import { recall, scopeCompatible, scopeMatchScore } from "./index.js";
import type { Reranker } from "./index.js";

const embedder = new HashingEmbedder({ dim: 64 });

// Seed a few beliefs directly through the reducer (no live LLM).
async function seed(db: DB): Promise<void> {
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
      {
        op: "CREATE",
        kind: "goal",
        predicate: "learn_language",
        value: "spanish",
        confidence: 0.8,
        evidence: ["obs-3"],
      },
    ],
    { now: 0 },
  );
}

describe("scope helpers", () => {
  it("scopeCompatible only excludes on a defined mismatch", () => {
    expect(scopeCompatible({}, { surface: "docs" })).toBe(true);
    expect(scopeCompatible({ surface: "slack" }, {})).toBe(true);
    expect(scopeCompatible({ surface: "slack" }, { surface: "slack" })).toBe(
      true,
    );
    expect(scopeCompatible({ surface: "slack" }, { surface: "docs" })).toBe(
      false,
    );
  });

  it("scopeMatchScore rewards confirmed scope and never zeroes", () => {
    expect(scopeMatchScore({}, {})).toBe(1);
    expect(scopeMatchScore({ surface: "slack" }, { surface: "slack" })).toBe(1);
    // Scoped belief, unknown context dimension: applicable but less certain.
    expect(scopeMatchScore({ surface: "slack" }, {})).toBe(0.5);
  });
});

describe("recall (read path)", () => {
  let db: DB;

  beforeEach(() => {
    db = openDb();
  });

  afterEach(() => {
    db.close();
  });

  it("ranks the belief matching the query first", async () => {
    await seed(db);
    const pack = await recall(
      db,
      embedder,
      "what is my writing style",
      {},
      {
        now: 0,
        includeObservations: false,
        minScore: 0,
      },
    );
    expect(pack.abstained).toBe(false);
    expect(pack.beliefs[0]?.predicate).toBe("writing_style");
    expect(pack.text).toContain("writing_style: concise");
  });

  it("abstains when nothing matches", async () => {
    await seed(db);
    // Pure-keyword recall (alpha=1) gives true zeros for absent terms, so a
    // query sharing no tokens with any belief yields no candidates. The vector
    // half of the stub embedder has a hash-collision noise floor, which is
    // precisely why the design leans on BM25 for clean abstention.
    const pack = await recall(
      db,
      embedder,
      "quantum chromodynamics lagrangian",
      {},
      { now: 0, includeObservations: false, alpha: 1 },
    );
    expect(pack.abstained).toBe(true);
    expect(pack.beliefs).toHaveLength(0);
    expect(pack.text).toBe("");
  });

  it("excludes a scope-incompatible belief and includes it in-scope", async () => {
    await applyOps(
      db,
      embedder,
      [
        {
          op: "CREATE",
          kind: "preference",
          predicate: "greeting_style",
          value: "formal",
          scope: { surface: "email" },
          confidence: 0.9,
          evidence: ["obs-1"],
        },
      ],
      { now: 0 },
    );

    const inSlack = await recall(
      db,
      embedder,
      "greeting style",
      {
        surface: "slack",
      },
      { now: 0, includeObservations: false },
    );
    expect(inSlack.beliefs).toHaveLength(0);

    const inEmail = await recall(
      db,
      embedder,
      "greeting style",
      {
        surface: "email",
      },
      { now: 0, includeObservations: false },
    );
    expect(inEmail.beliefs[0]?.predicate).toBe("greeting_style");
  });

  it("pulls a connected belief in via graph expansion", async () => {
    await seed(db);
    const beliefs = listBeliefs(db);
    const writing = beliefs.find((b) => b.predicate === "writing_style")!;
    const airport = beliefs.find((b) => b.predicate === "home_airport")!;
    // Connect the two so a query hitting only writing_style also surfaces the
    // airport belief, which shares no query tokens.
    addEdge(db, {
      srcId: writing.id,
      dstId: airport.id,
      type: "related",
      weight: 1,
      ts: 0,
    });

    const withGraph = await recall(
      db,
      embedder,
      "writing style",
      {},
      {
        now: 0,
        includeObservations: false,
        graphHops: 1,
      },
    );
    const ids = withGraph.beliefs.map((b) => b.id);
    expect(ids).toContain(airport.id);

    // With graph expansion disabled the unconnected-by-query belief drops out.
    const noGraph = await recall(
      db,
      embedder,
      "writing style",
      {},
      {
        now: 0,
        includeObservations: false,
        graphHops: 0,
      },
    );
    expect(noGraph.beliefs.map((b) => b.id)).not.toContain(airport.id);
  });

  it("keeps the rendered pack within the char budget", async () => {
    await seed(db);
    const pack = await recall(
      db,
      embedder,
      "writing style airport spanish",
      {},
      {
        now: 0,
        includeObservations: false,
        minScore: 0,
        maxChars: 60,
      },
    );
    expect(pack.text.length).toBeLessThanOrEqual(60);
  });

  it("applies a pluggable intent-aware reranker", async () => {
    await seed(db);
    const reverse: Reranker = {
      async rerank(_query, _context, candidates) {
        return [...candidates].reverse();
      },
    };
    const normal = await recall(
      db,
      embedder,
      "writing style airport",
      {},
      {
        now: 0,
        includeObservations: false,
        minScore: 0,
      },
    );
    const reranked = await recall(
      db,
      embedder,
      "writing style airport",
      {},
      {
        now: 0,
        includeObservations: false,
        minScore: 0,
        reranker: reverse,
      },
    );
    expect(reranked.beliefs.map((b) => b.id)).toEqual(
      [...normal.beliefs.map((b) => b.id)].reverse(),
    );
  });

  it("surfaces relevant raw observations alongside beliefs", async () => {
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
          evidence: ["obs-1"],
        },
      ],
      { now: 0 },
    );
    // Ingest a raw observation the query should retrieve.
    const { ingestObservation } = await import("../ingest/index.js");
    await ingestObservation(db, embedder, {
      source: "slack",
      actor: "user",
      content: "please keep your writing concise",
      ts: 0,
    });

    const pack = await recall(
      db,
      embedder,
      "writing concise",
      {},
      {
        now: 0,
        includeObservations: true,
        minScore: 0,
      },
    );
    expect(pack.observations.length).toBeGreaterThan(0);
    expect(pack.observations[0]?.content).toContain("concise");
  });

  it("demotes observations that only support a superseded belief", async () => {
    // obs-old supports a belief that obs-new later supersedes. Real ledger
    // rows are required: provenance stores observation ids, and the
    // recall observation path reads observations back from the ledger by id.
    const { ingestObservation } = await import("../ingest/index.js");
    const obsOld = await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "my home city is boston",
      ts: 0,
    });
    const obsNew = await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "correction, my home city is now seattle",
      ts: 1,
    });

    await applyOps(
      db,
      embedder,
      [
        {
          op: "CREATE",
          kind: "fact",
          predicate: "home_city",
          value: "boston",
          confidence: 0.9,
          evidence: [obsOld.id],
        },
      ],
      { now: 0 },
    );
    const [first] = listBeliefs(db, {});
    await applyOps(
      db,
      embedder,
      [
        {
          op: "CONTRADICT",
          beliefId: first!.id,
          newValue: "seattle",
          confidence: 0.9,
          evidence: [obsNew.id],
        },
      ],
      { now: 1 },
    );

    const withFilter = await recall(
      db,
      embedder,
      "home city",
      {},
      { topKObservations: 10, minScore: 0, demoteSuperseded: true },
    );
    const withoutFilter = await recall(
      db,
      embedder,
      "home city",
      {},
      { topKObservations: 10, minScore: 0, demoteSuperseded: false },
    );

    const scoreOf = (pack: typeof withFilter, id: string) =>
      pack.observations.find((o) => o.id === id)?.score ?? 0;

    // Present in both packs: demotion must not remove it from either. A bare
    // score comparison with a "?? 0" fallback cannot tell demoted-and-present
    // apart from filtered-out-entirely, so presence is asserted explicitly.
    expect(withFilter.observations.map((o) => o.id)).toContain(obsOld.id);
    expect(withoutFilter.observations.map((o) => o.id)).toContain(obsOld.id);

    // The stale observation is still reachable, but ranks lower than it did.
    expect(scoreOf(withFilter, obsOld.id)).toBeLessThan(
      scoreOf(withoutFilter, obsOld.id),
    );
  });

  it("keeps a demoted observation in the pack when its base score clears minScore but the penalized score would not", async () => {
    // Real caller configurations (mem0-adapter-server, cli-locomo,
    // cli-prefeval, diag-judge-agreement) all use minScore: 0.3. An
    // observation whose base score sits in (0.3, 0.6] would, if the penalty
    // were applied before the minScore filter, drop to (0.15, 0.3] and be
    // filtered out entirely: demotion turning into deletion. minScore must
    // gate on the unpenalised score so membership only ever depends on merit,
    // not on supersession.
    const { ingestObservation } = await import("../ingest/index.js");
    const query = "color";
    const oldContent =
      "years ago someone mentioned that my favorite color happened to be blue during a long conversation";
    const newContent = "correction, my favorite color is now green";
    const filler = "totally unrelated content about spaceships and rockets";

    const obsOld = await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: oldContent,
      ts: 0,
    });
    const obsNew = await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: newContent,
      ts: 1,
    });
    await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: filler,
      ts: 2,
    });

    await applyOps(
      db,
      embedder,
      [
        {
          op: "CREATE",
          kind: "preference",
          predicate: "favorite_color",
          value: "blue",
          confidence: 0.9,
          evidence: [obsOld.id],
        },
      ],
      { now: 0 },
    );
    const [first] = listBeliefs(db, {});
    await applyOps(
      db,
      embedder,
      [
        {
          op: "CONTRADICT",
          beliefId: first!.id,
          newValue: "green",
          confidence: 0.9,
          evidence: [obsNew.id],
        },
      ],
      { now: 1 },
    );

    // Confirm the fixture actually lands where the test needs it: base score
    // clears 0.3 on its own, but halved would not.
    const unpenalized = await recall(
      db,
      embedder,
      query,
      {},
      { topKObservations: 10, minScore: 0, demoteSuperseded: false },
    );
    const base = unpenalized.observations.find(
      (o) => o.id === obsOld.id,
    )?.score;
    expect(base).toBeGreaterThan(0.3);
    expect(base).toBeLessThanOrEqual(0.6);
    expect(base! * 0.5).toBeLessThan(0.3);

    const withFilter = await recall(
      db,
      embedder,
      query,
      {},
      { topKObservations: 10, minScore: 0.3, demoteSuperseded: true },
    );
    expect(withFilter.observations.map((o) => o.id)).toContain(obsOld.id);
  });

  it("does not penalize an observation that also supports an active belief", async () => {
    // obs-shared is provenance for both the belief CONTRADICT supersedes and
    // the belief it is superseded by. It still supports an active belief, so
    // it is not stale and must score exactly as it would with demotion off.
    const { ingestObservation } = await import("../ingest/index.js");
    const obsOld = await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "my home city is boston",
      ts: 0,
    });
    const obsShared = await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "home city update, still boston for now, later seattle",
      ts: 1,
    });

    await applyOps(
      db,
      embedder,
      [
        {
          op: "CREATE",
          kind: "fact",
          predicate: "home_city",
          value: "boston",
          confidence: 0.9,
          evidence: [obsOld.id],
        },
      ],
      { now: 0 },
    );
    const [first] = listBeliefs(db, {});
    await applyOps(
      db,
      embedder,
      [
        {
          op: "CONTRADICT",
          beliefId: first!.id,
          newValue: "seattle",
          confidence: 0.9,
          // obsShared also backs the new, active belief.
          evidence: [obsShared.id],
        },
      ],
      { now: 1 },
    );
    // obsShared additionally backs the belief CONTRADICT superseded (first,
    // now status "superseded"), so it ends up provenance for both a
    // superseded belief and the active one.
    await applyOps(
      db,
      embedder,
      [
        {
          op: "REINFORCE",
          beliefId: first!.id,
          delta: 0.01,
          evidence: [obsShared.id],
        },
      ],
      { now: 1 },
    );

    const withFilter = await recall(
      db,
      embedder,
      "home city",
      {},
      { topKObservations: 10, minScore: 0, demoteSuperseded: true },
    );
    const withoutFilter = await recall(
      db,
      embedder,
      "home city",
      {},
      { topKObservations: 10, minScore: 0, demoteSuperseded: false },
    );

    const scoreOf = (pack: typeof withFilter, id: string) =>
      pack.observations.find((o) => o.id === id)?.score;

    // Present in both, and undemoted: supporting an active belief overrides
    // the fact that it also supports a superseded one.
    expect(withFilter.observations.map((o) => o.id)).toContain(obsShared.id);
    const filtered = scoreOf(withFilter, obsShared.id);
    const unfiltered = scoreOf(withoutFilter, obsShared.id);
    expect(filtered).toBeDefined();
    expect(filtered).toBe(unfiltered);
  });

  it("exposes a pre-attenuation hybrid on the same scale as observation scores", async () => {
    await seed(db);
    const pack = await recall(
      db,
      embedder,
      "writing style",
      {},
      {
        topKBeliefs: 5,
        topKObservations: 0,
        minScore: 0,
      },
    );
    expect(pack.beliefs.length).toBeGreaterThan(0);
    for (const b of pack.beliefs) {
      expect(b.hybrid).toBeGreaterThanOrEqual(0);
      expect(b.hybrid).toBeLessThanOrEqual(1);
      // The attenuated score can only be lower than or equal to the raw blend,
      // because eff, rec, and sm are each in [0,1].
      expect(b.score).toBeLessThanOrEqual(b.hybrid + 1e-9);
    }
  });

  it("carries a belief's ts as its lastReinforcedTs", async () => {
    await seed(db);
    const pack = await recall(
      db,
      embedder,
      "writing style",
      {},
      { topKBeliefs: 5, topKObservations: 0, minScore: 0 },
    );
    expect(pack.beliefs.length).toBeGreaterThan(0);
    const stored = listBeliefs(db);
    for (const b of pack.beliefs) {
      const record = stored.find((r) => r.id === b.id);
      expect(record).toBeDefined();
      expect(b.ts).toBe(record!.lastReinforcedTs);
    }
  });

  it("moves ts forward on reinforcement, distinct from the belief's createdTs", async () => {
    await seed(db);
    const before = listBeliefs(db).find(
      (b) => b.predicate === "writing_style",
    )!;
    expect(before.createdTs).toBe(0);

    await applyOps(
      db,
      embedder,
      [
        {
          op: "REINFORCE",
          beliefId: before.id,
          delta: 0.05,
          evidence: ["obs-4"],
        },
      ],
      { now: 5000 },
    );

    const pack = await recall(
      db,
      embedder,
      "writing style",
      {},
      { topKBeliefs: 5, topKObservations: 0, minScore: 0 },
    );
    const reinforced = pack.beliefs.find((b) => b.id === before.id);
    expect(reinforced).toBeDefined();
    expect(reinforced!.ts).toBe(5000);
    expect(reinforced!.ts).not.toBe(before.createdTs);
  });
});

describe("observation slot expansion (F6)", () => {
  let db: DB;

  beforeEach(() => {
    db = openDb();
  });

  afterEach(() => {
    db.close();
  });

  it("with slotCharBudget 0, content is byte-identical to today", async () => {
    const { ingestObservation } = await import("../ingest/index.js");
    // "gorgonzola" appears only in the anchor's content, so pure-BM25
    // (alpha: 1) gives the neighbour a score of exactly 0 and only the
    // anchor clears minScore, making selection deterministic.
    const anchor = await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "gorgonzola concert is tuesday",
      ts: 100_000,
    });
    await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "the opener starts at eight",
      ts: 101_000,
    });

    const pack = await recall(
      db,
      embedder,
      "gorgonzola",
      {},
      { topKObservations: 1, minScore: 0, alpha: 1, slotCharBudget: 0 },
    );
    expect(pack.observations[0]?.id).toBe(anchor.id);
    expect(pack.observations[0]?.content).toBe(anchor.content);
  });

  it("with a budget set, a slot's content includes its immediate neighbours and stays within budget", async () => {
    const { ingestObservation } = await import("../ingest/index.js");
    // "kraxel" appears only in the anchor's content, so pure-BM25 (alpha: 1)
    // gives before/after a score of exactly 0 and the anchor is the only
    // candidate that clears minScore, making selection deterministic.
    const before = await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "the opening act warmed up the crowd nicely",
      ts: 100_000,
    });
    const anchor = await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "kraxel absolutely tore up the stage tonight",
      ts: 101_000,
    });
    const after = await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "everyone sang along during the final song",
      ts: 102_000,
    });

    const budget =
      before.content.length + anchor.content.length + after.content.length + 2; // two single-space joins

    const pack = await recall(
      db,
      embedder,
      "kraxel",
      {},
      {
        topKObservations: 1,
        minScore: 0,
        alpha: 1,
        slotCharBudget: budget,
        neighbourGapMs: 60_000,
      },
    );
    const slot = pack.observations[0];
    expect(slot?.id).toBe(anchor.id);
    expect(slot?.content).toContain(before.content);
    expect(slot?.content).toContain(anchor.content);
    expect(slot?.content).toContain(after.content);
    expect(slot?.content.length ?? 0).toBeLessThanOrEqual(budget);
  });

  it("does not join neighbours separated by more than neighbourGapMs (no cross-session merge)", async () => {
    const { ingestObservation } = await import("../ingest/index.js");
    // "kraxel" appears only in the anchor's content (see BM25 note above).
    // Far in the past, a different session. More than neighbourGapMs (5000ms)
    // away from the anchor.
    const distant = await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "someone once talked about sourdough starters",
      ts: 0,
    });
    const anchor = await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "kraxel tour kicked off with a bang",
      ts: 100_000,
    });
    const near = await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "the crowd cheered through every song after",
      ts: 101_000,
    });

    const pack = await recall(
      db,
      embedder,
      "kraxel",
      {},
      {
        topKObservations: 1,
        minScore: 0,
        alpha: 1,
        slotCharBudget: 10_000,
        neighbourGapMs: 5_000,
      },
    );
    const slot = pack.observations[0];
    expect(slot?.id).toBe(anchor.id);
    expect(slot?.content).toContain(near.content);
    expect(slot?.content).not.toContain(distant.content);
  });

  it("keeps the anchor's id, ts, and score unchanged by expansion", async () => {
    const { ingestObservation } = await import("../ingest/index.js");
    // "marmalade" appears only in the anchor's content (see BM25 note above).
    await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "the festival lineup was announced this morning",
      ts: 100_000,
    });
    const anchor = await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "marmalade confirmed as this year's headliner",
      ts: 101_000,
    });
    await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "tickets for the festival sold out fast",
      ts: 102_000,
    });

    const unexpanded = await recall(
      db,
      embedder,
      "marmalade",
      {},
      { topKObservations: 1, minScore: 0, alpha: 1, slotCharBudget: 0 },
    );
    const expanded = await recall(
      db,
      embedder,
      "marmalade",
      {},
      { topKObservations: 1, minScore: 0, alpha: 1, slotCharBudget: 10_000 },
    );

    expect(expanded.observations[0]?.id).toBe(anchor.id);
    expect(expanded.observations[0]?.id).toBe(unexpanded.observations[0]?.id);
    expect(expanded.observations[0]?.ts).toBe(unexpanded.observations[0]?.ts);
    expect(expanded.observations[0]?.score).toBe(
      unexpanded.observations[0]?.score,
    );
  });

  it("orders expanded content chronologically with the anchor in its natural position", async () => {
    const { ingestObservation } = await import("../ingest/index.js");
    // "zeppelinfest" appears only in the anchor's content (see BM25 note above).
    const first = await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "the gates opened right on schedule",
      ts: 100_000,
    });
    const anchor = await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "zeppelinfest headliner took the stage",
      ts: 101_000,
    });
    const last = await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "the crowd slowly went home after",
      ts: 102_000,
    });

    const pack = await recall(
      db,
      embedder,
      "zeppelinfest",
      {},
      { topKObservations: 1, minScore: 0, alpha: 1, slotCharBudget: 10_000 },
    );
    const content = pack.observations[0]?.content ?? "";
    expect(content).toBe(
      [first.content, anchor.content, last.content].join(" "),
    );
    expect(content.indexOf(first.content)).toBeLessThan(
      content.indexOf(anchor.content),
    );
    expect(content.indexOf(anchor.content)).toBeLessThan(
      content.indexOf(last.content),
    );
  });

  it("never includes the same observation twice within one slot", async () => {
    const { ingestObservation } = await import("../ingest/index.js");
    // "harborlight" appears only in the anchor's content (see BM25 note above).
    const ts0 = await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "the session opened with a soundcheck",
      ts: 100_000,
    });
    const anchor = await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "harborlight took the stage for the main set",
      ts: 101_000,
    });
    const ts2 = await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "the session closed with a long encore",
      ts: 102_000,
    });

    const pack = await recall(
      db,
      embedder,
      "harborlight",
      {},
      { topKObservations: 1, minScore: 0, alpha: 1, slotCharBudget: 10_000 },
    );
    const content = pack.observations[0]?.content ?? "";
    const parts = content.split(" ");
    for (const obs of [ts0, anchor, ts2]) {
      const contentParts = obs.content.split(" ");
      let occurrences = 0;
      for (let i = 0; i + contentParts.length <= parts.length; i++) {
        if (contentParts.every((word, j) => parts[i + j] === word)) {
          occurrences++;
        }
      }
      expect(occurrences).toBe(1);
    }
  });

  it("does not change which observation ranks first, or the selected order, across multiple anchors", async () => {
    // Fix round 1: the adapter's flattenPack dedup was collapsing distinct
    // expanded slots and, downstream, shifting which id looked "first" after
    // the harness re-sorts by created_at. That was a flattenPack bug, not a
    // recall() ranking bug. This proves recall()'s own selection and order
    // are untouched by slotCharBudget: each of the three query terms below
    // appears only in its own anchor (see BM25 note above), so all three are
    // selected and their relative order depends only on score.
    const { ingestObservation } = await import("../ingest/index.js");
    const strongest = await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "brackenfall brackenfall brackenfall headliner set",
      ts: 100_000,
    });
    const middle = await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "brackenfall brackenfall opening act",
      ts: 200_000,
    });
    const weakest = await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "brackenfall closing remarks",
      ts: 300_000,
    });
    // Filler around each anchor so expansion has neighbours to pull in.
    await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "the crowd settled in for the show",
      ts: 100_500,
    });
    await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "merch tables opened at noon",
      ts: 200_500,
    });
    await ingestObservation(db, embedder, {
      source: "test",
      actor: "user",
      content: "the lights came up as fans left",
      ts: 300_500,
    });

    const unexpanded = await recall(
      db,
      embedder,
      "brackenfall",
      {},
      { topKObservations: 3, minScore: 0, alpha: 1, slotCharBudget: 0 },
    );
    const expanded = await recall(
      db,
      embedder,
      "brackenfall",
      {},
      { topKObservations: 3, minScore: 0, alpha: 1, slotCharBudget: 500 },
    );

    // Same three anchors, same relative order, same ids/ts/scores; only
    // content differs (expanded pulls in a filler neighbour).
    expect(unexpanded.observations.map((o) => o.id)).toEqual([
      strongest.id,
      middle.id,
      weakest.id,
    ]);
    expect(expanded.observations.map((o) => o.id)).toEqual(
      unexpanded.observations.map((o) => o.id),
    );
    expect(expanded.observations.map((o) => o.ts)).toEqual(
      unexpanded.observations.map((o) => o.ts),
    );
    expect(expanded.observations.map((o) => o.score)).toEqual(
      unexpanded.observations.map((o) => o.score),
    );
    expect(expanded.observations[0]?.content).not.toBe(
      unexpanded.observations[0]?.content,
    );
  });
});
