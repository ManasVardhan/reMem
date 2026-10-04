import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ReMemKernel } from "../kernel.js";
import { HashingEmbedder } from "../embed/index.js";

describe("ingest (Phase 1: storage + observe)", () => {
  let kernel: ReMemKernel;

  beforeEach(() => {
    kernel = new ReMemKernel();
  });

  afterEach(() => {
    kernel.close();
  });

  it("round-trips an observation with context and meta intact", async () => {
    const written = await kernel.observe({
      source: "slack",
      actor: "user",
      content: "I prefer concise answers.",
      contextSnapshot: { surface: "slack", project: "reMem" },
      meta: { threadId: "T123" },
    });

    const read = kernel.observation(written.id);
    expect(read).toBeDefined();
    expect(read?.content).toBe("I prefer concise answers.");
    expect(read?.source).toBe("slack");
    expect(read?.actor).toBe("user");
    expect(read?.ts).toBe(written.ts);
    // observe() stamps where the prompt came from, alongside the caller's
    // context rather than replacing it.
    expect(read?.contextSnapshot).toEqual({
      surface: "slack",
      project: "reMem",
      origin: "user",
    });
    expect(read?.meta).toEqual({ threadId: "T123" });
  });

  it("stores an embedding of the embedder's dimension", async () => {
    const embedder = new HashingEmbedder({ dim: 64 });
    const k = new ReMemKernel({ embedder });
    const written = await k.observe({
      source: "manual",
      actor: "user",
      content: "hello world hello",
    });
    const read = k.observation(written.id);
    expect(read?.embedding).toBeInstanceOf(Float32Array);
    expect(read?.embedding.length).toBe(64);
    // Round-trip preserves the vector exactly.
    expect(Array.from(read!.embedding)).toEqual(Array.from(written.embedding));
    // Non-empty content yields a non-zero, L2-normalized vector.
    const norm = Math.sqrt(
      Array.from(read!.embedding).reduce((s, x) => s + x * x, 0),
    );
    expect(norm).toBeCloseTo(1, 5);
    k.close();
  });

  it("defaults ts to now when omitted and preserves an explicit ts", async () => {
    const before = Date.now();
    const auto = await kernel.observe({
      source: "manual",
      actor: "user",
      content: "no timestamp",
    });
    expect(auto.ts).toBeGreaterThanOrEqual(before);

    const explicit = await kernel.observe({
      ts: 1000,
      source: "manual",
      actor: "user",
      content: "fixed timestamp",
    });
    expect(explicit.ts).toBe(1000);
  });

  it("returns observations oldest-first regardless of insert order", async () => {
    await kernel.observe({
      ts: 300,
      source: "manual",
      actor: "user",
      content: "c",
    });
    await kernel.observe({
      ts: 100,
      source: "manual",
      actor: "user",
      content: "a",
    });
    await kernel.observe({
      ts: 200,
      source: "manual",
      actor: "user",
      content: "b",
    });

    const all = kernel.observations();
    expect(all.map((o) => o.content)).toEqual(["a", "b", "c"]);
  });

  it("filters by since and source", async () => {
    await kernel.observe({
      ts: 10,
      source: "email",
      actor: "user",
      content: "old email",
    });
    await kernel.observe({
      ts: 20,
      source: "slack",
      actor: "user",
      content: "slack msg",
    });
    await kernel.observe({
      ts: 30,
      source: "email",
      actor: "user",
      content: "new email",
    });

    expect(kernel.observations({ since: 20 }).map((o) => o.content)).toEqual([
      "slack msg",
      "new email",
    ]);
    expect(
      kernel.observations({ source: "email" }).map((o) => o.content),
    ).toEqual(["old email", "new email"]);
  });

  it("rejects invalid input at the boundary", async () => {
    await expect(
      // @ts-expect-error deliberately invalid actor
      kernel.observe({ source: "manual", actor: "robot", content: "x" }),
    ).rejects.toThrow();
  });

  it("enforces an append-only ledger (no UPDATE, no DELETE)", async () => {
    const written = await kernel.observe({
      source: "manual",
      actor: "user",
      content: "immutable",
    });

    expect(() =>
      kernel.raw
        .prepare("UPDATE observation SET content = ? WHERE id = ?")
        .run("tampered", written.id),
    ).toThrow(/append-only/);

    expect(() =>
      kernel.raw
        .prepare("DELETE FROM observation WHERE id = ?")
        .run(written.id),
    ).toThrow(/append-only/);

    // The row survived both attempts unchanged.
    expect(kernel.observation(written.id)?.content).toBe("immutable");
  });
});
