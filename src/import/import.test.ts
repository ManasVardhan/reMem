import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../db/client.js";
import { HashingEmbedder } from "../embed/index.js";
import { importClaudeMem, findClaudeMemDb } from "./claude-mem.js";
import { listEpisodes, getEpisodeObservationIds } from "../episodes/index.js";
import { listSessions } from "../sessions/index.js";
import { readObservations } from "../ingest/index.js";

// A stand-in claude-mem store. Built to the real schema so the importer is
// tested against the shape it will actually meet, without needing anyone's
// personal database on disk.
function makeSource(path: string): void {
  const src = new Database(path);
  src.exec(`
    CREATE TABLE sdk_sessions (
      content_session_id TEXT UNIQUE NOT NULL,
      memory_session_id TEXT UNIQUE,
      project TEXT NOT NULL,
      user_prompt TEXT,
      started_at_epoch INTEGER NOT NULL,
      completed_at_epoch INTEGER,
      status TEXT,
      custom_title TEXT
    );
    CREATE TABLE user_prompts (
      id INTEGER PRIMARY KEY,
      content_session_id TEXT NOT NULL,
      prompt_number INTEGER NOT NULL,
      prompt_text TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT, subtitle TEXT, narrative TEXT, text TEXT,
      facts TEXT, concepts TEXT, files_read TEXT, files_modified TEXT,
      prompt_number INTEGER,
      created_at_epoch INTEGER NOT NULL
    );
    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      request TEXT, investigated TEXT, learned TEXT, completed TEXT,
      next_steps TEXT, files_read TEXT, files_edited TEXT,
      prompt_number INTEGER,
      created_at_epoch INTEGER NOT NULL
    );
  `);
  src
    .prepare(
      `INSERT INTO sdk_sessions VALUES ('cs1','ms1','reMem','open the viewer',1000,2000,'completed',NULL)`,
    )
    .run();
  src
    .prepare(
      `INSERT INTO user_prompts VALUES (1,'cs1',1,'open the viewer',1000),(2,'cs1',2,'make it blue',1500)`,
    )
    .run();
  src
    .prepare(
      `INSERT INTO observations VALUES
        (1,'ms1','reMem','feature','Made it blue','the accent changed','narrative here',NULL,
         '["blue is for commands"]','["ui"]','["a.ts"]','["b.ts"]',2,1600)`,
    )
    .run();
  src
    .prepare(
      `INSERT INTO session_summaries VALUES
        (1,'ms1','reMem','open the viewer','looked at css','blue reads better','shipped it',
         'ship','["a.ts"]','["b.ts"]',2,1900)`,
    )
    .run();
  src.close();
}

describe("porting a claude-mem store", () => {
  let dir: string;
  let source: string;
  let db: DB;
  const embedder = new HashingEmbedder();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "remem-import-"));
    source = join(dir, "claude-mem.db");
    makeSource(source);
    db = openDb({ path: ":memory:" });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("puts what the user said in the ledger and what a model wrote in episodes", async () => {
    const report = await importClaudeMem(db, embedder, { from: source });
    expect(report.observations).toBe(2);
    // One observation row plus one summary row.
    expect(report.episodes).toBe(2);
    expect(report.sessions).toBe(1);

    const observations = readObservations(db);
    expect(observations.map((o) => o.content)).toEqual([
      "open the viewer",
      "make it blue",
    ]);
    // Every ledger row is something a person actually typed.
    expect(observations.every((o) => o.actor === "user")).toBe(true);

    const episodes = listEpisodes(db);
    expect(episodes.map((e) => e.title).sort()).toEqual([
      "Made it blue",
      "open the viewer",
    ]);
  });

  it("links an account to the turn it came from, not the whole session", async () => {
    await importClaudeMem(db, embedder, { from: source });
    const episode = listEpisodes(db).find((e) => e.title === "Made it blue");
    const sources = getEpisodeObservationIds(db, episode!.id);
    expect(sources).toHaveLength(1);

    const observation = readObservations(db).find(
      (o) => o.content === "make it blue",
    );
    expect(sources[0]).toBe(observation!.id);
  });

  it("carries structure across: facts, concepts and files", async () => {
    await importClaudeMem(db, embedder, { from: source });
    const episode = listEpisodes(db).find((e) => e.title === "Made it blue")!;
    expect(episode.kind).toBe("feature");
    expect(episode.facts).toEqual(["blue is for commands"]);
    expect(episode.concepts).toEqual(["ui"]);
    expect(episode.filesRead).toEqual(["a.ts"]);
    expect(episode.filesChanged).toEqual(["b.ts"]);
  });

  it("carries the session, its title and its close", async () => {
    await importClaudeMem(db, embedder, { from: source });
    const session = listSessions(db)[0]!;
    expect(session.title).toBe("open the viewer");
    expect(session.status).toBe("completed");
    expect(session.endedTs).toBe(2000);
    expect(session.source).toBe("claude-mem");
  });

  it("imports nothing the second time", async () => {
    await importClaudeMem(db, embedder, { from: source });
    const again = await importClaudeMem(db, embedder, { from: source });
    expect(again.observations).toBe(0);
    expect(again.episodes).toBe(0);
    expect(again.skippedObservations).toBe(2);
    expect(again.skippedEpisodes).toBe(2);
    expect(readObservations(db)).toHaveLength(2);
    expect(listEpisodes(db)).toHaveLength(2);
  });

  it("writes nothing on a dry run", async () => {
    const report = await importClaudeMem(db, embedder, {
      from: source,
      dryRun: true,
    });
    expect(report.observations).toBe(2);
    expect(readObservations(db)).toHaveLength(0);
    expect(listEpisodes(db)).toHaveLength(0);
  });

  it("narrows to a project", async () => {
    const report = await importClaudeMem(db, embedder, {
      from: source,
      project: "somethingElse",
    });
    expect(report.observations).toBe(0);
    expect(report.sessions).toBe(0);
  });

  it("says where it looked when there is nothing to import from", async () => {
    await expect(
      importClaudeMem(db, embedder, { from: join(dir, "absent.db") }),
    ).rejects.toThrow(/no claude-mem database found/);
  });

  it("reports no source rather than a wrong one when none exists", () => {
    expect(findClaudeMemDb(join(dir, "absent.db"))).toBeUndefined();
    expect(findClaudeMemDb(source)).toBe(source);
  });
});
