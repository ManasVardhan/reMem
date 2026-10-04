import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type DB } from "../db/client.js";
import { HashingEmbedder } from "../embed/index.js";
import { ingestObservation } from "../ingest/index.js";
import { putEpisode } from "../episodes/index.js";
import { search, timeline, toMatchQuery } from "./index.js";

const embedder = new HashingEmbedder();

async function seed(db: DB): Promise<void> {
  await ingestObservation(db, embedder, {
    id: "o1",
    ts: 1000,
    source: "code",
    actor: "user",
    content: "I prefer blue over green for accent highlights",
    contextSnapshot: { projectName: "reMem" },
  });
  await ingestObservation(db, embedder, {
    id: "o2",
    ts: 2000,
    source: "code",
    actor: "assistant",
    content: "Changed src/viewer/page.html",
    contextSnapshot: { projectName: "reMem" },
  });
  await ingestObservation(db, embedder, {
    id: "o3",
    ts: 3000,
    source: "code",
    actor: "user",
    content: "the green accent is wrong on the install blocks",
    contextSnapshot: { projectName: "other" },
  });
  putEpisode(db, {
    id: "e1",
    ts: 2500,
    project: "reMem",
    title: "Swapped the accent to blue",
    narrative: "Commands take a slate blue now",
    facts: ["sage stays for what is currently true"],
  });
}

describe("search", () => {
  let db: DB;
  beforeEach(async () => {
    db = openDb({ path: ":memory:" });
    await seed(db);
  });

  it("quotes every token so punctuation cannot be a syntax error", () => {
    expect(toMatchQuery("blue accent")).toBe('"blue" AND "accent"');
    expect(toMatchQuery('a "quoted" one')).toBe('"a" AND "quoted" AND "one"');
    expect(toMatchQuery("   ")).toBe("");
  });

  it("does not throw on input that is FTS syntax", () => {
    for (const q of ["NEAR(", '"', "a OR", "*", "-x", "((("]) {
      expect(() => search(db, { query: q })).not.toThrow();
    }
  });

  it("finds what the user said", () => {
    const res = search(db, { query: "blue" });
    const ids = res.hits.map((h) => h.id);
    expect(ids).toContain("o1");
  });

  it("finds derived accounts", () => {
    const res = search(db, { query: "slate" });
    expect(res.hits.map((h) => h.id)).toContain("e1");
  });

  it("filters by project on the display name", () => {
    const res = search(db, { query: "green", project: "other" });
    expect(res.hits.map((h) => h.id)).toEqual(["o3"]);
  });

  it("gives each kind a share of a small page rather than one kind taking it", () => {
    // The regression this guards: episodes sorted ahead of observations, so a
    // limit of 2 returned no prompts at all.
    const res = search(db, { query: "blue", limit: 2 });
    const kinds = new Set(res.hits.map((h) => h.kind));
    expect(kinds.size).toBeGreaterThan(1);
  });

  it("reports the true total, not the size of the page", () => {
    const res = search(db, { query: "blue", limit: 1 });
    expect(res.hits).toHaveLength(1);
    expect(res.total).toBeGreaterThan(1);
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(search(db, { query: "zzzznotpresent" }).hits).toEqual([]);
  });

  it("restricts to the kinds asked for", () => {
    const res = search(db, { query: "blue", kinds: ["observation"] });
    expect(res.hits.every((h) => h.kind === "observation")).toBe(true);
  });
});

describe("timeline", () => {
  let db: DB;
  beforeEach(async () => {
    db = openDb({ path: ":memory:" });
    await seed(db);
  });

  it("returns what surrounded a moment, in order, with the anchor marked", () => {
    const entries = timeline(db, { anchorTs: 2000, before: 2, after: 2 });
    const times = entries.map((e) => e.ts);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(entries.find((e) => e.anchor)?.id).toBe("o2");
  });

  it("includes episodes in the surrounding window", () => {
    const entries = timeline(db, { anchorTs: 2000, before: 2, after: 2 });
    expect(entries.some((e) => e.kind === "episode")).toBe(true);
  });

  it("scopes to a project", () => {
    const entries = timeline(db, { anchorTs: 2000, project: "other" });
    expect(
      entries.filter((e) => e.kind === "observation").map((e) => e.id),
    ).toEqual(["o3"]);
  });
});
