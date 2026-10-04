import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type DB } from "../db/client.js";
import {
  putEpisode,
  getEpisode,
  listEpisodes,
  countEpisodes,
  getEpisodeObservationIds,
} from "./index.js";

describe("episodes", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb({ path: ":memory:" });
  });

  it("stores an account with its provenance", () => {
    const e = putEpisode(db, {
      title: "Ported claude-mem",
      subtitle: "1834 prompts",
      kind: "feature",
      facts: ["provenance is one turn, not the session"],
      concepts: ["import"],
      filesChanged: ["src/import/claude-mem.ts"],
      observationIds: ["o1", "o2"],
    });
    expect(e.title).toBe("Ported claude-mem");
    expect(e.facts).toEqual(["provenance is one turn, not the session"]);
    expect(getEpisodeObservationIds(db, e.id).sort()).toEqual(["o1", "o2"]);
  });

  it("rewrites by id rather than duplicating, because it is derived", () => {
    putEpisode(db, { id: "e1", title: "first take", observationIds: ["o1"] });
    putEpisode(db, { id: "e1", title: "better take", observationIds: ["o2"] });
    expect(getEpisode(db, "e1")?.title).toBe("better take");
    expect(listEpisodes(db)).toHaveLength(1);
    // Provenance accumulates: the second pass saw more of the same session.
    expect(getEpisodeObservationIds(db, "e1").sort()).toEqual(["o1", "o2"]);
  });

  it("defaults arrays rather than returning null", () => {
    const e = putEpisode(db, { title: "bare" });
    expect(e.facts).toEqual([]);
    expect(e.concepts).toEqual([]);
    expect(e.filesRead).toEqual([]);
    expect(e.filesChanged).toEqual([]);
  });

  it("lists newest first", () => {
    putEpisode(db, { id: "a", title: "older", ts: 100 });
    putEpisode(db, { id: "b", title: "newer", ts: 200 });
    expect(listEpisodes(db).map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("filters by project, session, kind and time", () => {
    putEpisode(db, {
      id: "a",
      title: "a",
      ts: 100,
      project: "one",
      kind: "bugfix",
      sessionId: "s1",
    });
    putEpisode(db, {
      id: "b",
      title: "b",
      ts: 200,
      project: "two",
      kind: "feature",
      sessionId: "s2",
    });
    expect(listEpisodes(db, { project: "one" }).map((e) => e.id)).toEqual([
      "a",
    ]);
    expect(listEpisodes(db, { kind: "feature" }).map((e) => e.id)).toEqual([
      "b",
    ]);
    expect(listEpisodes(db, { sessionId: "s2" }).map((e) => e.id)).toEqual([
      "b",
    ]);
    expect(listEpisodes(db, { since: 150 }).map((e) => e.id)).toEqual(["b"]);
    expect(listEpisodes(db, { until: 150 }).map((e) => e.id)).toEqual(["a"]);
  });

  it("counts, overall and by project", () => {
    putEpisode(db, { id: "a", title: "a", project: "one" });
    putEpisode(db, { id: "b", title: "b", project: "two" });
    expect(countEpisodes(db)).toBe(2);
    expect(countEpisodes(db, "one")).toBe(1);
  });
});
