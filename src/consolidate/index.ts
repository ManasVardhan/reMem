import type { DB } from "../db/client.js";
import type { Embedder } from "../embed/index.js";
import { readObservations, type ObservationQuery } from "../ingest/index.js";
import { listBeliefs } from "../beliefs/store.js";
import { parseOps } from "./ops.js";
import { applyOps, type ConsolidationReport } from "./reducer.js";
import type { Consolidator } from "./consolidator.js";

export interface ConsolidateOptions {
  // Only consider observations at or after this timestamp.
  since?: number;
  // Only consider one session's observations.
  sessionId?: string;
  // Ignore the watermark and consolidate the whole ledger. Expensive, and only
  // ever what you want for a deliberate backfill.
  all?: boolean;
  // Cap on how many observations go into one proposal. A window larger than
  // this is split and run in order, so importing years of history does not
  // produce a single prompt nothing can answer.
  batchSize?: number;
  now?: number;
  createFloor?: number;
}

// Where the last pass got to. Consolidation is incremental by default: without
// this, every session end would re-send the entire ledger to the model, which
// gets slower and more expensive for exactly the users who have the most in
// their store.
const WATERMARK = "consolidate:watermark";

// How far the last pass got, as a position in the ledger's append order.
//
// Not a timestamp: observations share milliseconds, so a time cursor either
// repeats the last row forever or drops its neighbours. Not an id either: ids
// are random, so a row appended at an equal timestamp can sort before the mark
// and never be consolidated at all.
export interface Watermark {
  rowid: number;
}

export function getWatermark(db: DB): Watermark | undefined {
  const row = db
    .prepare(`SELECT value FROM kv WHERE key = @key`)
    .get({ key: WATERMARK }) as { value: string } | undefined;
  if (!row) return undefined;
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Watermark).rowid === "number"
    ) {
      return parsed as Watermark;
    }
  } catch {
    // A store written before this format holds something else.
  }
  // Anything unrecognised, including the bare timestamp an earlier version
  // wrote, is discarded rather than guessed at. The cost is one pass that
  // re-reads the ledger; the cost of guessing wrong is observations that are
  // never consolidated.
  return undefined;
}

export function setWatermark(db: DB, mark: Watermark): void {
  db.prepare(
    `INSERT INTO kv (key, value) VALUES (@key, @value)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run({ key: WATERMARK, value: JSON.stringify(mark) });
}

export const DEFAULT_BATCH = 120;

// Orchestrates one consolidation pass: gather the observation window and the
// currently-relevant beliefs, ask the consolidator to propose ops, validate
// them (LLM output is untrusted), and apply them through the deterministic
// reducer.
//
// Relevant-belief selection is deliberately simple here (all active beliefs);
// the recall phase introduces scoped, intent-aware selection that this can later
// reuse.
export async function runConsolidation(
  db: DB,
  embedder: Embedder,
  consolidator: Consolidator,
  options: ConsolidateOptions = {},
): Promise<ConsolidationReport> {
  // Precedence: an explicit window, then where the last pass finished. Only
  // --all deliberately ignores both.
  const watermark = options.all ? undefined : getWatermark(db);
  const query: ObservationQuery = {};
  if (options.since !== undefined) query.since = options.since;
  else if (watermark) query.afterRowid = watermark.rowid;

  // Beliefs are about the user, so they are derived from what the user said.
  // An agent's own output is evidence about the agent; consolidating it makes
  // memory describe its own behaviour back to itself.
  let observations = readObservations(db, query).filter(
    (o) => o.actor === "user",
  );

  if (options.sessionId !== undefined) {
    observations = observations.filter(
      (o) =>
        (o.contextSnapshot as Record<string, unknown>).sessionId ===
        options.sessionId,
    );
  }

  const total: ConsolidationReport = {
    created: 0,
    reinforced: 0,
    contradicted: 0,
    refined: 0,
    nooped: 0,
    dropped: 0,
    invalid: 0,
  };

  if (observations.length === 0) return total;

  const batchSize = options.batchSize ?? DEFAULT_BATCH;
  const reducerOptions: { now?: number; createFloor?: number } = {};
  if (options.now !== undefined) reducerOptions.now = options.now;
  if (options.createFloor !== undefined)
    reducerOptions.createFloor = options.createFloor;

  for (let i = 0; i < observations.length; i += batchSize) {
    const window = observations.slice(i, i + batchSize);

    // Beliefs are re-read per batch, so a belief created by batch one can be
    // reinforced or contradicted by batch two rather than duplicated.
    const relevantBeliefs = listBeliefs(db, { status: "active" });

    const proposed = await consolidator.propose({
      observations: window,
      relevantBeliefs,
    });
    const { ops } = parseOps(proposed);
    const report = await applyOps(db, embedder, ops, reducerOptions);

    total.created += report.created;
    total.reinforced += report.reinforced;
    total.contradicted += report.contradicted;
    total.refined += report.refined;
    total.nooped += report.nooped;
    total.dropped += report.dropped;
    total.invalid += report.invalid;
  }

  // Only advance the watermark for an ordinary incremental pass. A backfill or
  // a single-session pass is not evidence that everything before it is done.
  //
  // The highest row in the window, not the last one returned: the window is
  // ordered by time, and an imported observation can carry an old timestamp
  // while sitting at the end of the ledger.
  if (options.sessionId === undefined && observations.length > 0) {
    let highest = 0;
    for (const o of observations) {
      if (o.rowid !== undefined && o.rowid > highest) highest = o.rowid;
    }
    if (highest > 0) setWatermark(db, { rowid: highest });
  }

  return total;
}

export type { ConsolidationReport } from "./reducer.js";
