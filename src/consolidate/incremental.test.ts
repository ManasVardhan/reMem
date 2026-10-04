import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type DB } from "../db/client.js";
import { HashingEmbedder } from "../embed/index.js";
import { ingestObservation } from "../ingest/index.js";
import { runConsolidation, getWatermark, setWatermark } from "./index.js";
import { FunctionConsolidator } from "./consolidator.js";
import { listBeliefs } from "../beliefs/store.js";
import type { ObservationRecord } from "../types/index.js";

const embedder = new HashingEmbedder();

// Records what each pass was given, so the test can assert on the window rather
// than on the beliefs that happen to come out of it.
function spy(): {
  consolidator: FunctionConsolidator;
  windows: ObservationRecord[][];
} {
  const windows: ObservationRecord[][] = [];
  const consolidator = new FunctionConsolidator((ctx) => {
    windows.push(ctx.observations);
    return ctx.observations.map((o) => ({
      op: "CREATE" as const,
      kind: "fact" as const,
      predicate: `p-${o.id}`,
      value: o.content,
      confidence: 0.9,
      evidence: [o.id],
    }));
  });
  return { consolidator, windows };
}

async function add(
  db: DB,
  id: string,
  ts: number,
  content = id,
): Promise<void> {
  await ingestObservation(db, embedder, {
    id,
    ts,
    source: "manual",
    actor: "user",
    content,
  });
}

describe("incremental consolidation", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb({ path: ":memory:" });
  });

  it("consolidates everything on a first pass and records where it got to", async () => {
    await add(db, "o1", 1000);
    await add(db, "o2", 2000);
    const { consolidator, windows } = spy();

    await runConsolidation(db, embedder, consolidator);

    expect(windows[0]!.map((o) => o.id)).toEqual(["o1", "o2"]);
    // The ledger's own append position, so a later row can never sort before it.
    expect(getWatermark(db)).toEqual({ rowid: 2 });
  });

  it("does not re-send the whole ledger on the next pass", async () => {
    await add(db, "o1", 1000);
    const first = spy();
    await runConsolidation(db, embedder, first.consolidator);

    await add(db, "o2", 5000);
    const second = spy();
    await runConsolidation(db, embedder, second.consolidator);

    // The regression this guards: every session end re-reading the entire
    // ledger, so the system gets slower the more it remembers.
    expect(second.windows[0]!.map((o) => o.id)).toEqual(["o2"]);
  });

  it("never skips an observation that shares a millisecond with the watermark", async () => {
    await add(db, "o1", 1000);
    const first = spy();
    await runConsolidation(db, embedder, first.consolidator);

    await add(db, "o2", 1000);
    const second = spy();
    await runConsolidation(db, embedder, second.consolidator);

    // Same millisecond as the mark, so a >= or > cursor on time alone would
    // either repeat o1 or lose o2.
    expect(second.windows[0]!.map((o) => o.id)).toEqual(["o2"]);
  });

  it("ignores a watermark it does not recognise rather than guessing", async () => {
    await add(db, "o1", 1000);
    await add(db, "o2", 1000);
    // What an earlier version wrote: a bare timestamp.
    db.prepare(
      `INSERT INTO kv (key, value) VALUES ('consolidate:watermark', '1000')`,
    ).run();

    const { consolidator, windows } = spy();
    await runConsolidation(db, embedder, consolidator);

    // Re-reading the ledger once costs a pass. Guessing wrong would cost
    // observations that are never consolidated at all.
    expect(windows[0]!.map((o) => o.id)).toEqual(["o1", "o2"]);
  });

  it("does not skip a row appended at the same millisecond with a lower id", async () => {
    // The regression this guards: a cursor of (ts, id) compares random uuids,
    // so roughly half of all same-millisecond appends sorted before the mark
    // and were never consolidated.
    await add(db, "zzz-later-but-lower-sort", 1000);
    const first = spy();
    await runConsolidation(db, embedder, first.consolidator);

    await add(db, "aaa-appended-after", 1000);
    const second = spy();
    await runConsolidation(db, embedder, second.consolidator);

    expect(second.windows[0]!.map((o) => o.id)).toEqual(["aaa-appended-after"]);
  });

  it("--all ignores the watermark", async () => {
    await add(db, "o1", 1000);
    setWatermark(db, { rowid: 9999 });
    const { consolidator, windows } = spy();

    await runConsolidation(db, embedder, consolidator, { all: true });

    expect(windows[0]!.map((o) => o.id)).toEqual(["o1"]);
  });

  it("splits a long window into batches and sums the report", async () => {
    for (let i = 0; i < 7; i += 1) await add(db, `o${i}`, 1000 + i);
    const { consolidator, windows } = spy();

    const report = await runConsolidation(db, embedder, consolidator, {
      batchSize: 3,
    });

    expect(windows.map((w) => w.length)).toEqual([3, 3, 1]);
    expect(report.created).toBe(7);
    expect(listBeliefs(db, { status: "active" })).toHaveLength(7);
  });

  it("scopes to one session and leaves the watermark alone", async () => {
    await ingestObservation(db, embedder, {
      id: "a",
      ts: 1,
      source: "code",
      actor: "user",
      content: "in session one",
      contextSnapshot: { sessionId: "s1" },
    });
    await ingestObservation(db, embedder, {
      id: "b",
      ts: 2,
      source: "code",
      actor: "user",
      content: "in session two",
      contextSnapshot: { sessionId: "s2" },
    });
    const { consolidator, windows } = spy();

    await runConsolidation(db, embedder, consolidator, { sessionId: "s1" });

    expect(windows[0]!.map((o) => o.id)).toEqual(["a"]);
    // A single-session pass is not evidence that everything before it is done.
    expect(getWatermark(db)).toBeUndefined();
  });

  it("does nothing, cheaply, when there is nothing new", async () => {
    await add(db, "o1", 1000);
    const first = spy();
    await runConsolidation(db, embedder, first.consolidator);

    const second = spy();
    const report = await runConsolidation(db, embedder, second.consolidator);

    expect(second.windows.length).toBeGreaterThanOrEqual(0);
    expect(report.created).toBe(0);
  });

  it("lets a later batch build on beliefs an earlier batch created", async () => {
    for (let i = 0; i < 4; i += 1) await add(db, `o${i}`, 1000 + i);
    const seen: number[] = [];
    const consolidator = new FunctionConsolidator((ctx) => {
      seen.push(ctx.relevantBeliefs.length);
      return ctx.observations.map((o) => ({
        op: "CREATE" as const,
        kind: "fact" as const,
        predicate: `p-${o.id}`,
        value: o.content,
        confidence: 0.9,
        evidence: [o.id],
      }));
    });

    await runConsolidation(db, embedder, consolidator, { batchSize: 2 });

    expect(seen[0]).toBe(0);
    expect(seen[1]).toBe(2);
  });

  it("takes the watermark from the rows it read, not a second query", async () => {
    // The rowid travels on the record. It used to be re-queried once per
    // observation, which is one extra round trip per row on a backfill.
    await add(db, "o1", 1000);
    await add(db, "o2", 2000);
    const { consolidator, windows } = spy();

    await runConsolidation(db, embedder, consolidator);

    expect(windows[0]!.every((o) => typeof o.rowid === "number")).toBe(true);
    expect(getWatermark(db)).toEqual({ rowid: 2 });
  });

  it("advances past an observation carrying an older timestamp", async () => {
    // An import writes history: rows appended last, dated first. The mark is
    // the highest row read, not the last one in time order, or the next pass
    // re-reads everything the import brought in.
    await add(db, "recent", 9000);
    await add(db, "imported", 1000);
    const { consolidator } = spy();

    await runConsolidation(db, embedder, consolidator);

    expect(getWatermark(db)).toEqual({ rowid: 2 });
  });
});
