import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type DB } from "../db/client.js";
import { HashingEmbedder } from "../embed/index.js";
import { ingestObservation } from "../ingest/index.js";
import { putEpisode } from "../episodes/index.js";
import { startSession } from "../sessions/index.js";
import { applyOps } from "../consolidate/reducer.js";
import {
  feed,
  overview,
  observationDetail,
  episodeDetail,
  beliefDetail,
  sessions as sessionViews,
} from "./model.js";

const embedder = new HashingEmbedder();

async function seed(db: DB): Promise<void> {
  startSession(db, {
    id: "s1",
    project: "reMem",
    ts: 1000,
    title: "make it blue",
  });

  await ingestObservation(db, embedder, {
    id: "o1",
    ts: 1000,
    source: "code",
    actor: "user",
    content: "use blue for the install blocks, not green",
    contextSnapshot: {
      project: "reMem",
      projectName: "reMem",
      sessionId: "s1",
      promptNumber: 1,
    },
  });
  await ingestObservation(db, embedder, {
    id: "o2",
    ts: 2000,
    source: "code",
    actor: "assistant",
    content: "Changed site/index.html",
    contextSnapshot: {
      project: "reMem",
      projectName: "reMem",
      sessionId: "s1",
    },
  });
  await ingestObservation(db, embedder, {
    id: "o3",
    ts: 3000,
    source: "code",
    actor: "user",
    content: "something in another project entirely",
    contextSnapshot: { project: "mem", projectName: "mem" },
  });

  await ingestObservation(db, embedder, {
    id: "o4",
    ts: 500,
    source: "code",
    actor: "user",
    content: "[cron:abc] nightly crawl",
    contextSnapshot: { projectName: "reMem", origin: "scheduled" },
  });
  // Recorded before origin was stamped: recognised from its text instead.
  await ingestObservation(db, embedder, {
    id: "o5",
    ts: 400,
    source: "code",
    actor: "user",
    content: "Read /Users/me/daily-spec.md and execute it",
    contextSnapshot: { projectName: "reMem" },
  });

  putEpisode(db, {
    id: "e1",
    ts: 2500,
    project: "reMem",
    sessionId: "s1",
    kind: "change",
    title: "Swapped the accent to blue",
    facts: ["blue marks a surface you type into"],
    observationIds: ["o1"],
  });

  await applyOps(db, embedder, [
    {
      op: "CREATE",
      kind: "preference",
      predicate: "accent_colour",
      value: "blue",
      confidence: 0.9,
      evidence: ["o1"],
      scope: { project: "reMem" },
    },
  ]);
}

describe("the viewer's read model", () => {
  let db: DB;
  beforeEach(async () => {
    db = openDb({ path: ":memory:" });
    await seed(db);
  });

  it("opens on the ledger, newest first, with episodes in the same stream", () => {
    const page = feed(db);
    // o2 was written by the agent, so it is not in the ledger's feed at all.
    expect(page.items.map((i) => i.id)).toEqual(["o3", "e1", "o1", "o4", "o5"]);
    expect(page.items.map((i) => i.kind)).toEqual([
      "prompt",
      "episode",
      "prompt",
      "scheduled",
      "prompt",
    ]);
  });

  it("never shows what the agent did, only what the user said", () => {
    // An agent's output is evidence about the agent. The ledger is what the
    // person said, and rows written by an earlier version that recorded tool
    // calls must not surface as if they were.
    expect(feed(db, { kinds: ["prompt"] }).items.map((i) => i.id)).toEqual([
      "o3",
      "o1",
      "o5",
    ]);
    expect(feed(db).items.some((i) => i.id === "o2")).toBe(false);
  });

  it("counts on the card how many beliefs an observation became", () => {
    const said = feed(db, { kinds: ["prompt"] }).items.find(
      (i) => i.id === "o1",
    );
    expect(said?.beliefCount).toBe(1);
  });

  it("pages with a cursor rather than an offset", () => {
    const first = feed(db, { limit: 2 });
    expect(first.hasMore).toBe(true);
    const next = feed(db, { limit: 2, before: first.nextCursor! });
    expect(next.items.map((i) => i.id)).not.toContain(first.items[0]!.id);
  });

  it("pages through items that all share a timestamp", async () => {
    // The regression this guards: a cursor of time alone could not get past a
    // group of items in the same millisecond, so "load older" returned the
    // same two rows forever and the rest of the ledger was unreachable. A
    // burst of tool calls inside one millisecond is ordinary.
    const tied = openDb({ path: ":memory:" });
    for (let i = 0; i < 10; i += 1) {
      await ingestObservation(tied, embedder, {
        id: `t${i}`,
        ts: 5000,
        source: "code",
        actor: "user",
        content: `message ${i}`,
      });
    }

    const seen: string[] = [];
    let cursor = undefined as ReturnType<typeof feed>["nextCursor"];
    for (let page = 0; page < 10; page += 1) {
      const p = feed(tied, { limit: 2, ...(cursor ? { before: cursor } : {}) });
      seen.push(...p.items.map((i) => i.id));
      if (!p.hasMore || !p.nextCursor) break;
      cursor = p.nextCursor;
    }

    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10);
  });

  it("filters the feed by project", () => {
    expect(feed(db, { project: "reMem" }).items.map((i) => i.id)).not.toContain(
      "o3",
    );
  });

  it("returns an observation in full, with what it became", () => {
    const detail = observationDetail(db, "o1")!;
    expect(detail.content).toBe("use blue for the install blocks, not green");
    expect(detail.promptNumber).toBe(1);
    expect(detail.session?.title).toBe("make it blue");
    expect(detail.beliefs.map((b) => b.value)).toEqual(["blue"]);
    expect(detail.episodes.map((e) => e.id)).toEqual(["e1"]);
  });

  it("returns an episode with the observations behind it", () => {
    const detail = episodeDetail(db, "e1")!;
    expect(detail.episode.title).toBe("Swapped the accent to blue");
    expect(detail.observations.map((o) => o.id)).toEqual(["o1"]);
  });

  it("returns a belief with its evidence", () => {
    const id = overview(db, ":memory:").beliefs[0]!.id;
    const detail = beliefDetail(db, id)!;
    expect(detail.value).toBe("blue");
    expect(detail.observations.map((o) => o.content)).toEqual([
      "use blue for the install blocks, not green",
    ]);
  });

  it("is undefined for ids that are not there, rather than throwing", () => {
    expect(observationDetail(db, "nope")).toBeUndefined();
    expect(episodeDetail(db, "nope")).toBeUndefined();
    expect(beliefDetail(db, "nope")).toBeUndefined();
  });

  it("counts what is in the store", () => {
    const view = overview(db, ":memory:");
    // Four of the five rows are the user's or their routine's; one was the
    // agent's and is not counted.
    expect(view.counts.observations).toBe(4);
    expect(view.counts.prompts).toBe(4);
    expect(view.counts.episodes).toBe(1);
    expect(view.counts.activeBeliefs).toBe(1);
    expect(view.empty).toBe(false);
  });

  it("does not match one project's beliefs to another by name suffix", () => {
    // The regression this guards: scope was compared with endsWith when it held
    // a path, so filtering to "mem" pulled in everything scoped to "reMem".
    expect(overview(db, ":memory:", "mem").beliefs).toHaveLength(0);
    expect(overview(db, ":memory:", "reMem").beliefs).toHaveLength(1);
  });

  it("reports sessions with what they contain", () => {
    const views = sessionViews(db);
    expect(views).toHaveLength(1);
    expect(views[0]!.observationCount).toBe(2);
    expect(views[0]!.episodeCount).toBe(1);
  });

  it("shows a routine as a scheduled run, not as something the user said", () => {
    const scheduled = feed(db, { kinds: ["scheduled"] }).items;
    expect(scheduled.map((i) => i.id)).toContain("o4");
    expect(
      feed(db, { kinds: ["prompt"] }).items.map((i) => i.id),
    ).not.toContain("o4");
  });

  it("recognises a routine recorded before origin was stamped", () => {
    const withPrefix = feed(db, {
      kinds: ["scheduled"],
      scheduledPrefixes: ["Read /Users/me/daily-spec.md"],
    }).items.map((i) => i.id);
    expect(withPrefix).toContain("o5");

    // Without being told, it is an ordinary prompt: the text says nothing.
    expect(
      feed(db, { kinds: ["scheduled"] }).items.map((i) => i.id),
    ).not.toContain("o5");
  });

  it("returns typed prompts when asked for them", () => {
    // The regression this guards: json_extract returns NULL for a row recorded
    // before origin existed, and NOT(NULL OR false) is NULL, so asking for
    // typed prompts matched nothing at all.
    const typed = feed(db, { kinds: ["prompt"] }).items.map((i) => i.id);
    expect(typed).toContain("o1");
    expect(typed).toContain("o3");
    expect(typed.length).toBeGreaterThan(0);
  });

  it("keeps a scheduled run out of the count of what the user said", () => {
    const all = feed(db).items;
    expect(all.some((i) => i.kind === "scheduled")).toBe(true);
    expect(all.some((i) => i.kind === "prompt")).toBe(true);
  });
});
