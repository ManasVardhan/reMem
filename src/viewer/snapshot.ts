// The viewer's read model, separated from the HTTP server so it can be tested
// without binding a port.

import { existsSync } from "node:fs";
import { openDb } from "../db/client.js";
import { listBeliefs, getProvenanceObservationIds } from "../beliefs/store.js";
import { getObservation } from "../ingest/index.js";
import type { Scope } from "../types/index.js";

export interface ViewerObservation {
  ts: number;
  actor: string;
  content: string;
}

export interface ViewerBelief {
  id: string;
  predicate: string;
  value: string;
  confidence: number;
  scope: Scope;
  createdTs: number;
  observations: ViewerObservation[];
}

export interface ViewerState {
  dbPath: string;
  counts: { active: number; superseded: number };
  beliefs: ViewerBelief[];
  superseded: Array<{
    id: string;
    predicate: string;
    value: string;
    createdTs: number;
  }>;
}

export const MAX_ACTIVE = 200;
export const MAX_SUPERSEDED = 100;

export function snapshot(path: string): ViewerState {
  // Before anything has been observed there is no file, and a readonly open
  // cannot create one. An empty store is a normal state, not an error.
  if (!existsSync(path)) {
    return {
      dbPath: path,
      counts: { active: 0, superseded: 0 },
      beliefs: [],
      superseded: [],
    };
  }

  // Opened per call so the viewer always reflects the current store and never
  // holds a write lock against a live session.
  const db = openDb({ path, readonly: true });
  try {
    const active = listBeliefs(db, { status: "active" });
    const superseded = listBeliefs(db, { status: "superseded" });

    const beliefs: ViewerBelief[] = active.slice(0, MAX_ACTIVE).map((b) => ({
      id: b.id,
      predicate: b.predicate,
      value: b.value,
      confidence: b.confidence,
      scope: b.scope,
      createdTs: b.createdTs,
      observations: getProvenanceObservationIds(db, b.id)
        .map((id) => getObservation(db, id))
        .filter((o): o is NonNullable<typeof o> => o !== undefined)
        .map((o) => ({ ts: o.ts, actor: o.actor, content: o.content })),
    }));

    return {
      dbPath: path,
      counts: { active: active.length, superseded: superseded.length },
      beliefs,
      superseded: superseded.slice(0, MAX_SUPERSEDED).map((b) => ({
        id: b.id,
        predicate: b.predicate,
        value: b.value,
        createdTs: b.createdTs,
      })),
    };
  } finally {
    db.close();
  }
}

// Find the first free port at or above `start`. 37777 belongs to claude-mem, so
// reMem starts above it rather than fighting for the same one.
export function firstFreePort(
  start: number,
  tries: number,
  createServer: () => {
    once: (ev: string, cb: (err?: NodeJS.ErrnoException) => void) => void;
    listen: (port: number, host: string) => void;
    close: (cb?: () => void) => void;
  },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (port: number, left: number) => {
      if (left === 0) {
        reject(new Error(`no free port in ${start}..${start + tries - 1}`));
        return;
      }
      const probe = createServer();
      probe.once("error", (err) => {
        probe.close();
        if (err && err.code === "EADDRINUSE") attempt(port + 1, left - 1);
        else reject(err ?? new Error("probe failed"));
      });
      probe.once("listening", () => probe.close(() => resolve(port)));
      probe.listen(port, "127.0.0.1");
    };
    attempt(start, tries);
  });
}
