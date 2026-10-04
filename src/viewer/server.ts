#!/usr/bin/env node
// A local, read-only window onto the ledger and the belief layer.
//
// It opens on the ledger, because that is the thing a person can check: the
// words they actually typed, in order. Beliefs sit above it as the derived
// summary, and every one of them can be clicked back down to the observations
// that produced it.
//
// Read-only by construction: the store is opened readonly and no route writes.

import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { dbPath, scheduledPrefixes } from "../mcp/store.js";
import { firstFreePort } from "./snapshot.js";
import {
  withDb,
  overview,
  feed,
  observationDetail,
  episodeDetail,
  beliefDetail,
  sessions,
  searchAll,
  type FeedKind,
} from "./model.js";
import { PAGE } from "./page.js";
import { ReMemKernel } from "../kernel.js";
import { selectEmbedder } from "../embed/select.js";
import type { Embedder } from "../embed/index.js";

// 37777 is claude-mem's. Start above it and take the first free port so two
// memory viewers can coexist. An explicit REMEM_VIEWER_PORT is honoured as-is
// and fails loudly if taken, because that is a deliberate request.
const BASE_PORT = 37800;
const MAX_TRIES = 40;

// The embedder, loaded once and kept.
//
// A sentence model costs about a second to load and two milliseconds to run.
// Every hook is a fresh process, so a hook that loads its own copy pays that
// second on every prompt. This process is already running and already has the
// store open, so it pays it once and answers in milliseconds.
let embedderOnce:
  | Promise<{ embedder: Embedder; degraded?: string }>
  | undefined;

function sharedEmbedder(
  store: string,
): Promise<{ embedder: Embedder; degraded?: string }> {
  if (!embedderOnce) {
    embedderOnce = (async () => {
      const probe = new ReMemKernel({ db: { path: store } });
      try {
        const selected = await selectEmbedder(probe.raw);
        return selected.degraded
          ? { embedder: selected.embedder, degraded: selected.degraded }
          : { embedder: selected.embedder };
      } finally {
        probe.close();
      }
    })();
  }
  return embedderOnce;
}

const EMPTY_OVERVIEW = {
  dbPath: "",
  counts: {
    observations: 0,
    prompts: 0,
    episodes: 0,
    sessions: 0,
    activeBeliefs: 0,
    supersededBeliefs: 0,
  },
  projects: [],
  beliefs: [],
  hasFts: false,
  empty: true,
};

function json(
  res: import("node:http").ServerResponse,
  body: unknown,
  status = 200,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const q = url.searchParams;
  const project = q.get("project") ?? undefined;
  const store = dbPath();

  try {
    // Before anything has been observed there is no file. An empty store is a
    // normal state, so every route answers with its empty shape rather than an
    // error the page would have to special-case.
    if (path === "/api/overview") {
      const data = withDb(store, (db) => overview(db, store, project));
      json(res, data ?? { ...EMPTY_OVERVIEW, dbPath: store });
      return;
    }

    if (path === "/api/feed") {
      const kinds = q.get("kinds");
      const data = withDb(store, (db) =>
        feed(db, {
          ...(project ? { project } : {}),
          ...(q.get("session") ? { sessionId: q.get("session")! } : {}),
          ...(kinds ? { kinds: kinds.split(",") as FeedKind[] } : {}),
          scheduledPrefixes: scheduledPrefixes(),
          ...(q.get("before") && q.get("beforeId")
            ? {
                before: {
                  ts: Number(q.get("before")),
                  id: q.get("beforeId")!,
                },
              }
            : {}),
          ...(q.get("limit") ? { limit: Number(q.get("limit")) } : {}),
        }),
      );
      json(res, data ?? { items: [], hasMore: false });
      return;
    }

    if (path.startsWith("/api/observation/")) {
      const id = decodeURIComponent(path.slice("/api/observation/".length));
      const data = withDb(store, (db) =>
        observationDetail(db, id, scheduledPrefixes()),
      );
      if (!data) {
        json(res, { error: "not found" }, 404);
        return;
      }
      json(res, data);
      return;
    }

    if (path.startsWith("/api/episode/")) {
      const id = decodeURIComponent(path.slice("/api/episode/".length));
      const data = withDb(store, (db) => episodeDetail(db, id));
      if (!data) {
        json(res, { error: "not found" }, 404);
        return;
      }
      json(res, data);
      return;
    }

    if (path.startsWith("/api/belief/")) {
      const id = decodeURIComponent(path.slice("/api/belief/".length));
      const data = withDb(store, (db) => beliefDetail(db, id));
      if (!data) {
        json(res, { error: "not found" }, 404);
        return;
      }
      json(res, data);
      return;
    }

    // Recall on behalf of a hook. Same store, same embedder, already warm.
    //
    // Read-only like every other route here, and reachable only from loopback.
    // It exists because the alternative is every prompt paying a model load.
    if (path === "/api/recall") {
      const query = q.get("q") ?? "";
      if (query.trim() === "") {
        json(res, { beliefs: [], abstained: true });
        return;
      }
      void (async () => {
        try {
          const { embedder } = await sharedEmbedder(store);
          const kernel = new ReMemKernel({
            db: { path: store, readonly: true },
            embedder,
          });
          try {
            const pack = await kernel.recall(
              query,
              project ? { project } : {},
              {
                topKBeliefs: Number(q.get("topK") ?? 60),
                ...(q.get("alpha") ? { alpha: Number(q.get("alpha")) } : {}),
              },
            );
            json(res, {
              abstained: pack.abstained,
              beliefs: pack.beliefs.map((b) => ({
                id: b.id,
                predicate: b.predicate,
                value: b.value,
                confidence: b.confidence,
                score: b.score,
              })),
            });
          } finally {
            kernel.close();
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          json(res, { error: message }, 500);
        }
      })();
      return;
    }

    // One vector for one string, from the warm model.
    //
    // An observation carries an embedding, so recording one needs the model
    // too. Without this a hook loads its own copy to embed a single sentence,
    // which is most of what a prompt costs.
    if (path === "/api/embed") {
      const text = q.get("text") ?? "";
      if (text.trim() === "") {
        json(res, { error: "text is required" }, 400);
        return;
      }
      void (async () => {
        try {
          const { embedder } = await sharedEmbedder(store);
          const vector = await embedder.embed(text);
          json(res, { dim: embedder.dim, vector: Array.from(vector) });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          json(res, { error: message }, 500);
        }
      })();
      return;
    }

    if (path === "/api/sessions") {
      const data = withDb(store, (db) => sessions(db, project));
      json(res, { sessions: data ?? [] });
      return;
    }

    if (path === "/api/search") {
      const query = q.get("q") ?? "";
      if (query.trim() === "") {
        json(res, { hits: [], total: 0, usedFts: false });
        return;
      }
      const data = withDb(store, (db) => searchAll(db, query, project));
      json(res, data ?? { hits: [], total: 0, usedFts: false });
      return;
    }

    // Kept from the first viewer so anything pointed at it keeps working.
    if (path === "/api/state") {
      const data = withDb(store, (db) => overview(db, store, project));
      json(res, data ?? { ...EMPTY_OVERVIEW, dbPath: store });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(PAGE);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    json(res, { error: message }, 500);
  }
});

// Is a reMem viewer already serving here? Anything else on the port is not,
// and we should step around it rather than assume.
async function viewerAt(candidate: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300);
    const res = await fetch(`http://127.0.0.1:${candidate}/api/overview`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return false;
    const body: unknown = await res.json();
    return typeof body === "object" && body !== null && "counts" in body;
  } catch {
    return false;
  }
}

const requested = process.env.REMEM_VIEWER_PORT;

// One viewer, one address. Starting a second on the next free port is how a
// bookmark ends up pointing at a stale instance: the page still loads, so
// nothing looks wrong, and it quietly serves an older build against the same
// store. If one is already there, say so and step aside.
if (!requested && (await viewerAt(BASE_PORT))) {
  process.stdout.write(
    `A reMem viewer is already running @ http://localhost:${BASE_PORT}\n`,
  );
  process.exit(0);
}

const port = requested
  ? Number(requested)
  : await firstFreePort(BASE_PORT, MAX_TRIES, () => createNetServer());

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    process.stderr.write(
      `reMem viewer: port ${port} is already in use. Unset REMEM_VIEWER_PORT to auto-select.\n`,
    );
    process.exit(1);
  }
  throw err;
});

// Where a running viewer announces itself. The port is chosen at startup, so
// without this nothing else can find it: not the hook that decides whether to
// start one, not a person who closed the tab and wants it back.
const STATE = join(homedir(), ".remem", "viewer.json");

function announce(): void {
  try {
    mkdirSync(dirname(STATE), { recursive: true });
    writeFileSync(
      STATE,
      JSON.stringify(
        {
          port,
          pid: process.pid,
          startedAt: Date.now(),
          // Which store this viewer serves. There is one claim file and any
          // number of possible stores: point a second viewer at a fixture with
          // REMEM_DB and it takes over the claim. Without this line the hooks
          // cannot tell, and they would ask that viewer to embed and recall
          // against the real ledger, writing vectors from the wrong embedder
          // into an append-only table.
          db: resolve(dbPath()),
        },
        null,
        2,
      ),
    );
  } catch {
    // Announcing is a convenience. A viewer that cannot write the file still
    // serves pages, so this must not stop it.
  }
}

function withdraw(): void {
  try {
    unlinkSync(STATE);
  } catch {
    // Already gone, or never written.
  }
}

// Leave no claim behind on the way out, or the next session will believe a
// viewer is running and never start one.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    withdraw();
    process.exit(0);
  });
}
process.on("exit", withdraw);

// Bind to loopback only. This is a window onto a personal memory store and has
// no business being reachable from the network.
server.listen(port, "127.0.0.1", () => {
  announce();
  process.stdout.write(`View Observations Live @ http://localhost:${port}\n`);
});
