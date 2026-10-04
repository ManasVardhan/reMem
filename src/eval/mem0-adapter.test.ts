import { describe, it, expect } from "vitest";
import { flattenPack, readConfig } from "./mem0-adapter-server.js";
import type { ContextPack } from "../recall/index.js";

// A pack with more observations than the limit, so observations alone would
// fill the window and starve beliefs under observations-first.
function packWith(obsCount: number, beliefCount: number): ContextPack {
  return {
    query: "q",
    context: {},
    beliefs: Array.from({ length: beliefCount }, (_, i) => ({
      id: `b-${i}`,
      kind: "fact" as const,
      predicate: `p${i}`,
      value: `v${i}`,
      confidence: 0.9,
      hybrid: 0.8,
      score: 0.5,
      ts: 1_600_000_000_000 + i * 1000,
    })),
    observations: Array.from({ length: obsCount }, (_, i) => ({
      id: `o-${i}`,
      ts: 1_700_000_000_000 + i * 1000,
      source: "manual",
      content: `observation ${i}`,
      score: 0.9 - i * 0.001,
    })),
    text: "",
    tokensEstimate: 0,
    abstained: false,
  } as unknown as ContextPack;
}

// A pack whose observations repeat the same surface text (`content`), the
// way LoCoMo's short utterances commonly do. `distinctObsCount` distinct
// values, each appearing `repeatsEach` times.
function packWithDuplicateObservations(
  distinctObsCount: number,
  repeatsEach: number,
  beliefCount: number,
): ContextPack {
  const observations = [];
  let i = 0;
  for (let d = 0; d < distinctObsCount; d++) {
    for (let r = 0; r < repeatsEach; r++) {
      observations.push({
        id: `o-${i}`,
        ts: 1_700_000_000_000 + i * 1000,
        source: "manual",
        content: `observation ${d}`,
        score: 0.9 - i * 0.0001,
      });
      i++;
    }
  }
  return {
    query: "q",
    context: {},
    beliefs: Array.from({ length: beliefCount }, (_, k) => ({
      id: `b-${k}`,
      kind: "fact" as const,
      predicate: `p${k}`,
      value: `v${k}`,
      confidence: 0.9,
      hybrid: 0.8,
      score: 0.5,
      ts: 1_600_000_000_000 + k * 1000,
    })),
    observations,
    text: "",
    tokensEstimate: 0,
    abstained: false,
  } as unknown as ContextPack;
}

// A pack where one belief's rendered memory ("predicate: value") collides
// with one observation's raw content, the way a belief's canonical
// restatement of a fact can coincide with the observation it was derived
// from. 5 beliefs, 25 distinct observations, one collision (b-0 vs o-0).
//
// Observation memory is raw content (undated; dating now travels on
// `created_at`, not in the text), so this collision is against `content`
// directly, the same shape a consolidator's canonical restatement of an
// observation could actually produce.
function packWithCollision(): ContextPack {
  const beliefCount = 5;
  const obsCount = 25;
  return {
    query: "q",
    context: {},
    beliefs: Array.from({ length: beliefCount }, (_, i) => ({
      id: `b-${i}`,
      kind: "fact" as const,
      predicate: `p${i}`,
      value: `v${i}`,
      confidence: 0.9,
      hybrid: 0.8,
      score: 0.5,
      ts: 1_600_000_000_000 + i * 1000,
    })),
    observations: Array.from({ length: obsCount }, (_, i) => ({
      id: `o-${i}`,
      ts: 1_700_000_000_000 + i * 1000,
      source: "manual",
      // o-0's content collides with b-0's rendered memory ("p0: v0").
      content: i === 0 ? "p0: v0" : `observation ${i}`,
      score: 0.9 - i * 0.001,
    })),
    text: "",
    tokensEstimate: 0,
    abstained: false,
  } as unknown as ContextPack;
}

// kernel.why() is only used for signal enrichment; a stub keeps this hermetic.
const stubKernel = {
  why: () => ({
    belief: { status: "active" as const },
    observations: [{ id: "o-0" }],
  }),
} as never;

describe("flattenPack quota mode", () => {
  it("guarantees beliefs inside the window when observations would fill it", () => {
    const pack = packWith(60, 12);
    const out = flattenPack(pack, "quota", 50, stubKernel, 10);

    expect(out).toHaveLength(50);

    // The head is observations, so the top of the ranking is untouched.
    expect(out.slice(0, 40).every((r) => r.id.startsWith("o-"))).toBe(true);

    // The reserved tail is beliefs.
    const tail = out.slice(40);
    expect(tail).toHaveLength(10);
    expect(tail.every((r) => r.id.startsWith("b-"))).toBe(true);
  });

  it("does not pad with beliefs that do not exist", () => {
    const pack = packWith(60, 3);
    const out = flattenPack(pack, "quota", 50, stubKernel, 10);
    expect(out).toHaveLength(50);
    expect(out.filter((r) => r.id.startsWith("b-"))).toHaveLength(3);
    expect(out.filter((r) => r.id.startsWith("o-"))).toHaveLength(47);
  });

  it("leaves observations-first behaviour unchanged", () => {
    const pack = packWith(60, 12);
    const out = flattenPack(pack, "observations-first", 50, stubKernel, 10);
    expect(out).toHaveLength(50);
    expect(out.every((r) => r.id.startsWith("o-"))).toBe(true);
  });

  it("dedupes duplicate observation text before slicing so the window still fills", () => {
    // 45 distinct observations, each repeated 3 times: 135 raw observations
    // but only 45 distinct. obsSlots = limit - reserved = 50 - 10 = 40, well
    // within the 45 distinct observations available, so a correct dedup
    // still fills the window and leaves the full belief tail intact.
    const pack = packWithDuplicateObservations(45, 3, 12);
    const out = flattenPack(pack, "quota", 50, stubKernel, 10);

    expect(out).toHaveLength(50);

    const tail = out.slice(40);
    expect(tail).toHaveLength(10);
    expect(tail.every((r) => r.id.startsWith("b-"))).toBe(true);
  });

  it("excludes a belief whose memory collides with an observation before sizing the quota", () => {
    // 5 beliefs, one (b-0) collides with observation o-0's content, leaving
    // 4 eligible beliefs. A quota of 4 is then fully satisfied by those 4,
    // and 25 distinct observations comfortably fill the remaining 16 slots
    // of a limit-20 window.
    const pack = packWithCollision();
    const out = flattenPack(pack, "quota", 20, stubKernel, 4);

    expect(out).toHaveLength(20);
    expect(out.some((r) => r.id === "b-0")).toBe(false);

    const tail = out.slice(16);
    expect(tail).toHaveLength(4);
    expect(tail.every((r) => r.id.startsWith("b-") && r.id !== "b-0")).toBe(
      true,
    );
  });

  it("carries the observation's ts as created_at, with memory left undated", () => {
    const pack = packWith(2, 0);
    const out = flattenPack(pack, "observations-first", 10, stubKernel, 0);
    // The LoCoMo harness sorts by created_at and renders its own date prefix
    // (or "(unknown date)" when created_at is absent); reMem must not also
    // date the memory text itself, or the answerer sees a doubled date.
    expect(out[0]!.memory).toBe("observation 0");
    expect(out[0]!.created_at).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("dates a belief's created_at from its ts (lastReinforcedTs), no longer null", () => {
    const pack = packWith(0, 2);
    const out = flattenPack(pack, "beliefs-first", 10, stubKernel, 0);
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.created_at !== null)).toBe(true);
    expect(out[0]!.created_at).toBe(new Date(1_600_000_000_000).toISOString());
    expect(out[1]!.created_at).toBe(new Date(1_600_000_001_000).toISOString());
  });

  it("makes a more recently reinforced belief sort later by created_at", () => {
    const pack = packWith(0, 0);
    pack.beliefs = [
      {
        id: "b-new",
        kind: "fact",
        predicate: "p-new",
        value: "new",
        scope: {},
        confidence: 0.9,
        hybrid: 0.8,
        score: 0.5,
        ts: 2_000_000_000_000,
      },
      {
        id: "b-old",
        kind: "fact",
        predicate: "p-old",
        value: "old",
        scope: {},
        confidence: 0.9,
        hybrid: 0.8,
        score: 0.5,
        ts: 1_000_000_000_000,
      },
    ] as unknown as ContextPack["beliefs"];

    const out = flattenPack(pack, "beliefs-first", 10, stubKernel, 0);
    // flattenPack does not reorder: rank order is untouched by dating.
    expect(out.map((r) => r.id)).toEqual(["b-new", "b-old"]);

    // Sorting explicitly by created_at, as a consumer resolving conflicts
    // by recency would, puts the more recently reinforced belief (b-new)
    // after the older one (b-old): the field is usable for that ordering.
    const sorted = [...out].sort((a, b) =>
      a.created_at! < b.created_at!
        ? -1
        : a.created_at! > b.created_at!
          ? 1
          : 0,
    );
    expect(sorted.map((r) => r.id)).toEqual(["b-old", "b-new"]);
  });

  it("renders same-session neighbours into one slot when windowing is on", () => {
    const pack = packWith(5, 0);
    // All five observations share a session ts in this fixture helper only when
    // built with a fixed ts, so build one explicitly.
    const sessionTs = 1_700_000_000_000;
    pack.observations = pack.observations.map((o, i) => ({
      ...o,
      ts: sessionTs,
      id: `o-${i}`,
    }));

    const out = flattenPack(pack, "observations-first", 10, stubKernel, 0, 1);

    // The slot for o-2 carries o-1 and o-3 alongside it.
    const slot = out.find((r) => r.id === "o-2");
    expect(slot).toBeDefined();
    expect(slot!.memory).toContain("observation 1");
    expect(slot!.memory).toContain("observation 2");
    expect(slot!.memory).toContain("observation 3");
    expect(slot!.memory).not.toContain("observation 0");
  });

  it("leaves slots untouched when windowing is off", () => {
    const pack = packWith(3, 0);
    const out = flattenPack(pack, "observations-first", 10, stubKernel, 0, 0);
    expect(out[0]!.memory).not.toContain("observation 1");
  });

  // Through the adapter, every turn in a session is ingested with the
  // identical harness timestamp and a randomUUID() id; readObservations'
  // tiebreak on equal ts is that random id (src/ingest/index.ts:125), so
  // same-session turns have no dialogue-order signal in the ledger. The
  // adapter's /memories handler now assigns each turn a distinct,
  // increasing ts within its session (see OBSERVATION_TURN_OFFSET_MS), and
  // flattenPack's grouping is told which observations share a session via
  // `sessionOf` (id -> session base ts). This fixture reproduces both
  // failure modes the old id-sort had: ids that sort nothing like dialogue
  // order, and a pack.observations array that arrives in recall's score
  // order rather than dialogue order.
  it("orders windowed neighbours by ingest ts, not by id or array order", () => {
    const sessionBase = 1_700_000_000_000;
    // Dialogue order is turn 0..4; ids are deliberately unsorted relative to
    // that order, and ts is assigned in dialogue order exactly as the
    // /memories handler does (base + turnIndex * 1000).
    const dialogue = [
      { id: "id-zzz", turn: 0 },
      { id: "id-mmm", turn: 1 },
      { id: "id-aaa", turn: 2 },
      { id: "id-ttt", turn: 3 },
      { id: "id-bbb", turn: 4 },
    ];
    const byTurn = dialogue.map((d) => ({
      id: d.id,
      ts: sessionBase + d.turn * 1000,
      source: "manual",
      content: `turn ${d.turn}`,
      score: 0.9,
    }));
    // Shuffle away from both dialogue order and id-lexical order, simulating
    // the relevance-ranked order flattenPack actually receives from recall().
    const observations = [
      byTurn[3]!,
      byTurn[0]!,
      byTurn[4]!,
      byTurn[1]!,
      byTurn[2]!,
    ];
    const sessionOf = new Map(dialogue.map((d) => [d.id, sessionBase]));

    const pack = {
      query: "q",
      context: {},
      beliefs: [],
      observations,
      text: "",
      tokensEstimate: 0,
      abstained: false,
    } as unknown as ContextPack;

    const out = flattenPack(
      pack,
      "observations-first",
      10,
      stubKernel,
      0,
      1,
      sessionOf,
    );

    const slot = out.find((r) => r.id === "id-aaa"); // dialogue turn 2
    expect(slot).toBeDefined();
    expect(slot!.memory).toContain("turn 1");
    expect(slot!.memory).toContain("turn 2");
    expect(slot!.memory).toContain("turn 3");
    expect(slot!.memory).not.toContain("turn 0");
    expect(slot!.memory).not.toContain("turn 4");
  });

  it("does not merge two different sessions into one window", () => {
    const sessionA = 1_700_000_000_000;
    const sessionB = sessionA + 86_400_000; // a day later, per LoCoMo spacing
    const makeTurn = (
      id: string,
      base: number,
      turn: number,
      label: string,
    ) => ({
      id,
      ts: base + turn * 1000,
      source: "manual",
      content: `${label} turn ${turn}`,
      score: 0.9,
    });
    const observations = [
      makeTurn("a-0", sessionA, 0, "sessionA"),
      makeTurn("a-1", sessionA, 1, "sessionA"),
      makeTurn("a-2", sessionA, 2, "sessionA"),
      makeTurn("b-0", sessionB, 0, "sessionB"),
      makeTurn("b-1", sessionB, 1, "sessionB"),
      makeTurn("b-2", sessionB, 2, "sessionB"),
    ];
    const sessionOf = new Map([
      ["a-0", sessionA],
      ["a-1", sessionA],
      ["a-2", sessionA],
      ["b-0", sessionB],
      ["b-1", sessionB],
      ["b-2", sessionB],
    ]);
    const pack = {
      query: "q",
      context: {},
      beliefs: [],
      observations,
      text: "",
      tokensEstimate: 0,
      abstained: false,
    } as unknown as ContextPack;

    // Sorted by ts across both sessions, a-2 and b-0 are adjacent (index 2
    // and 3 of 6). A window of 1 would pull b-0 into a-2's slot if grouping
    // fell back to naive ts-order adjacency instead of the explicit session
    // key, which is exactly the defect this test guards against.
    const out = flattenPack(
      pack,
      "observations-first",
      10,
      stubKernel,
      0,
      1,
      sessionOf,
    );

    const lastOfA = out.find((r) => r.id === "a-2");
    expect(lastOfA).toBeDefined();
    expect(lastOfA!.memory).not.toContain("sessionB");

    const firstOfB = out.find((r) => r.id === "b-0");
    expect(firstOfB).toBeDefined();
    expect(firstOfB!.memory).not.toContain("sessionA");
  });

  // Slot expansion (recall's slotCharBudget) can render two distinct anchors
  // into byte-identical passages when their neighbourhoods overlap heavily.
  // They are still two distinct retrieved observations and must occupy two
  // slots, not collapse into one. This must fail against a text-keyed
  // observation dedup: 5 distinct ids sharing one memory string would
  // collapse to 1 result under `seen.has(r.memory)`.
  it("keeps N distinct observations as N slots even when their rendered content is identical", () => {
    const pack = packWith(0, 0);
    pack.observations = Array.from({ length: 5 }, (_, i) => ({
      id: `o-${i}`,
      ts: 1_700_000_000_000 + i * 1000,
      source: "manual",
      // Every anchor expands to the same overlapping passage.
      content: "shared expanded passage text",
      score: 0.9 - i * 0.001,
    }));

    const out = flattenPack(pack, "observations-first", 10, stubKernel, 0);

    expect(out).toHaveLength(5);
    expect(new Set(out.map((r) => r.id)).size).toBe(5);
  });

  it("keeps N distinct observations as N slots under quota mode too, even with identical rendered content", () => {
    const pack = packWith(0, 3);
    pack.observations = Array.from({ length: 5 }, (_, i) => ({
      id: `o-${i}`,
      ts: 1_700_000_000_000 + i * 1000,
      source: "manual",
      content: "shared expanded passage text",
      score: 0.9 - i * 0.001,
    }));

    const out = flattenPack(pack, "quota", 10, stubKernel, 3);

    const obsResults = out.filter((r) => r.id.startsWith("o-"));
    expect(obsResults).toHaveLength(5);
    expect(new Set(obsResults.map((r) => r.id)).size).toBe(5);
  });

  // The generic (non-quota) cross-list dedup must still drop a belief whose
  // rendered text collides with an observation's content, even though
  // observations themselves are no longer deduped by text. Quota mode has
  // its own pre-filter for this (tested above); this exercises the shared
  // final loop that beliefs-first/observations-first/blended all go through.
  it("still drops a belief that collides with an observation's text outside quota mode", () => {
    const pack = packWith(0, 0);
    pack.observations = [
      {
        id: "o-0",
        ts: 1_700_000_000_000,
        source: "manual",
        content: "p0: v0",
        score: 0.9,
      },
    ];
    pack.beliefs = [
      {
        id: "b-0",
        kind: "fact",
        predicate: "p0",
        value: "v0",
        scope: {},
        confidence: 0.9,
        hybrid: 0.8,
        score: 0.5,
        ts: 1_600_000_000_000,
      },
    ];

    const out = flattenPack(pack, "observations-first", 10, stubKernel, 0);

    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("o-0");
  });
});

describe("adapter config", () => {
  it("defaults alpha to 0.3 and honours the env override", () => {
    delete process.env.REMEM_ALPHA;
    expect(readConfig().alpha).toBe(0.3);
    process.env.REMEM_ALPHA = "0.5";
    expect(readConfig().alpha).toBe(0.5);
    delete process.env.REMEM_ALPHA;
  });

  it("defaults the belief quota to 10", () => {
    delete process.env.REMEM_BELIEF_QUOTA;
    expect(readConfig().beliefQuota).toBe(10);
  });

  it("defaults demoteSuperseded to false and honours the env override", () => {
    delete process.env.REMEM_DEMOTE_SUPERSEDED;
    expect(readConfig().demoteSuperseded).toBe(false);
    process.env.REMEM_DEMOTE_SUPERSEDED = "true";
    expect(readConfig().demoteSuperseded).toBe(true);
    delete process.env.REMEM_DEMOTE_SUPERSEDED;
  });
});
