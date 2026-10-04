import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReMemKernel } from "../kernel.js";
import { FunctionConsolidator } from "../consolidate/consolidator.js";
import type { BeliefOp } from "../consolidate/ops.js";
import { snapshot, firstFreePort } from "./snapshot.js";

const dirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "remem-viewer-"));
  dirs.push(dir);
  return join(dir, "remem.db");
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function scripted() {
  return new FunctionConsolidator(async (ctx): Promise<BeliefOp[]> => {
    const ops: BeliefOp[] = [];
    for (const o of ctx.observations) {
      const m = /uses (\w+)/i.exec(o.content);
      if (!m) continue;
      const value = m[1]!;
      const prior = ctx.relevantBeliefs.find(
        (b) => b.predicate === "db" && b.status === "active",
      );
      if (prior && prior.value !== value) {
        ops.push({
          op: "CONTRADICT",
          beliefId: prior.id,
          newValue: value,
          confidence: 0.9,
          evidence: [o.id],
        });
      } else if (!prior) {
        ops.push({
          op: "CREATE",
          kind: "fact",
          predicate: "db",
          value,
          confidence: 0.95,
          evidence: [o.id],
        });
      }
    }
    return ops;
  });
}

describe("viewer snapshot", () => {
  it("treats a missing store as empty, not as an error", () => {
    const path = join(tempDbPath(), "does-not-exist.db");
    const state = snapshot(path);
    expect(state.counts).toEqual({ active: 0, superseded: 0 });
    expect(state.beliefs).toEqual([]);
    expect(state.dbPath).toBe(path);
  });

  it("shows the belief, its evidence, and what it replaced", async () => {
    const path = tempDbPath();
    const kernel = new ReMemKernel({
      db: { path },
      consolidator: scripted(),
    });

    await kernel.observe({
      source: "manual",
      actor: "user",
      content: "the team uses Postgres",
    });
    await kernel.consolidate();
    await kernel.observe({
      source: "manual",
      actor: "user",
      content: "we migrated, the team uses SQLite",
    });
    await kernel.consolidate();

    const state = snapshot(path);

    expect(state.counts).toEqual({ active: 1, superseded: 1 });
    expect(state.beliefs[0]!.value).toBe("SQLite");
    // The evidence chain is the thing a flat store cannot show.
    expect(state.beliefs[0]!.observations.map((o) => o.content)).toContain(
      "we migrated, the team uses SQLite",
    );
    expect(state.superseded[0]!.value).toBe("Postgres");
  });

  it("opens readonly, so viewing never mutates the store", async () => {
    const path = tempDbPath();
    const kernel = new ReMemKernel({ db: { path } });
    await kernel.observe({ source: "manual", actor: "user", content: "hello" });

    const before = kernel.observations().length;
    snapshot(path);
    snapshot(path);
    expect(kernel.observations()).toHaveLength(before);
  });
});

describe("port selection", () => {
  // A fake server so the test never binds a real socket.
  function fakeFactory(busy: Set<number>) {
    return () => {
      const handlers: Record<string, (err?: NodeJS.ErrnoException) => void> =
        {};
      return {
        once(ev: string, cb: (err?: NodeJS.ErrnoException) => void) {
          handlers[ev] = cb;
        },
        listen(port: number) {
          if (busy.has(port)) {
            const err = new Error("in use") as NodeJS.ErrnoException;
            err.code = "EADDRINUSE";
            queueMicrotask(() => handlers.error?.(err));
          } else {
            queueMicrotask(() => handlers.listening?.());
          }
        },
        close(cb?: () => void) {
          cb?.();
        },
      };
    };
  }

  it("takes the base port when it is free", async () => {
    expect(await firstFreePort(37800, 5, fakeFactory(new Set()))).toBe(37800);
  });

  it("steps past ports another memory viewer already holds", async () => {
    const busy = new Set([37800, 37801]);
    expect(await firstFreePort(37800, 5, fakeFactory(busy))).toBe(37802);
  });

  it("gives up with a clear error rather than scanning forever", async () => {
    const busy = new Set([37800, 37801, 37802]);
    await expect(firstFreePort(37800, 3, fakeFactory(busy))).rejects.toThrow(
      /no free port/,
    );
  });
});
