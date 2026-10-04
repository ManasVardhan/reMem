import { describe, it, expect, afterEach } from "vitest";
import {
  MemoryService,
  createMemoryService,
  defaultDbPath,
  defaultDataDir,
} from "./index.js";
import { fixtureConsolidator } from "../eval/fixtures.js";

// The integration layer drives the kernel through just two hooks. These tests
// exercise them end to end over the in-memory store with the scripted fixture
// consolidator, so they stay hermetic like the rest of the suite.

let service: MemoryService | undefined;

afterEach(() => {
  service?.close();
  service = undefined;
});

describe("MemoryService", () => {
  it("records turns and recalls a consolidated belief after flush", async () => {
    service = createMemoryService({
      consolidator: fixtureConsolidator(),
      consolidateEvery: 0, // manual: drive consolidation with flush()
    });

    await service.record({
      actor: "user",
      content: "My home airport is JFK.",
      ts: 1000,
    });
    await service.flush();

    const ctx = await service.contextBlock(
      "what is my home airport",
      {},
      {
        alpha: 1,
      },
    );
    expect(ctx.abstained).toBe(false);
    expect(ctx.text).toContain("home_airport");
    expect(ctx.text).toContain("JFK");
    expect(ctx.tokensEstimate).toBeGreaterThan(0);
  });

  it("auto-consolidates once the buffer reaches consolidateEvery", async () => {
    service = createMemoryService({
      consolidator: fixtureConsolidator(),
      consolidateEvery: 2,
    });

    // First turn buffers, no belief yet.
    await service.record({ actor: "user", content: "Hello there.", ts: 1000 });
    let beliefs = service.reMem.beliefs();
    expect(beliefs.length).toBe(0);

    // Second turn hits the threshold and triggers consolidation.
    await service.record({
      actor: "user",
      content: "My home airport is SFO.",
      ts: 2000,
    });
    beliefs = service.reMem.beliefs();
    expect(beliefs.some((b) => b.predicate === "home_airport")).toBe(true);
  });

  it("supersedes a stale belief so recall returns the current value", async () => {
    service = createMemoryService({
      consolidator: fixtureConsolidator(),
      consolidateEvery: 1, // consolidate after every turn so CONTRADICT sees the prior belief
    });

    await service.record({
      actor: "user",
      content: "My home airport is SFO.",
      ts: 1000,
    });
    await service.record({
      actor: "user",
      content: "I moved, I fly out of OAK now.",
      ts: 2000,
    });

    const ctx = await service.contextBlock(
      "what is my home airport",
      {},
      {
        alpha: 1,
      },
    );
    // The belief layer holds the current value; the superseded one is gone from
    // the active beliefs even though the raw SFO statement survives in the
    // immutable ledger (and may still surface as recent context).
    expect(ctx.text).toContain("OAK");
    expect(ctx.pack.beliefs.some((b) => b.value === "OAK")).toBe(true);
    expect(ctx.pack.beliefs.some((b) => b.value === "SFO")).toBe(false);
  });

  it("abstains and injects nothing when nothing is known", async () => {
    service = createMemoryService({ consolidator: fixtureConsolidator() });
    const ctx = await service.contextBlock(
      "what car do I drive",
      {},
      {
        alpha: 1,
      },
    );
    expect(ctx.abstained).toBe(true);
    expect(ctx.text).toBe("");
    expect(ctx.tokensEstimate).toBe(0);
  });

  it("works without a consolidator: ledger records, flush is a no-op", async () => {
    service = createMemoryService();
    const obs = await service.record({
      actor: "user",
      content: "note to self",
      ts: 1000,
    });
    expect(obs?.id).toBeTruthy();
    expect(await service.flush()).toBeUndefined();
    expect(service.reMem.observations().length).toBe(1);
  });

  it("skips the assistant's own turns rather than recording them", async () => {
    // A host can hand over the whole conversation without filtering it. What
    // the assistant said is produced from memory, so recording it would feed
    // memory its own output and reinforce whatever it already assumed.
    service = createMemoryService();

    const said = await service.record({
      actor: "user",
      content: "I use Kamal",
    });
    const replied = await service.record({
      actor: "assistant",
      content: "Noted, you use Kamal.",
    });

    expect(said?.id).toBeTruthy();
    expect(replied).toBeUndefined();
    expect(service.reMem.observations()).toHaveLength(1);
    expect(service.records("user")).toBe(true);
    expect(service.records("assistant")).toBe(false);
  });

  it("records other speakers when a corpus genuinely has them", async () => {
    service = createMemoryService({
      ledgerActors: ["user", "assistant"],
    });
    const replied = await service.record({
      actor: "assistant",
      content: "a second speaker in a dialogue corpus",
    });
    expect(replied?.id).toBeTruthy();
  });
});

describe("local-first path helpers", () => {
  it("defaultDbPath sits under defaultDataDir", () => {
    const dir = defaultDataDir("reMem");
    const dbPath = defaultDbPath("reMem");
    expect(dbPath.startsWith(dir)).toBe(true);
    expect(dbPath.endsWith("memory.db")).toBe(true);
  });
});
