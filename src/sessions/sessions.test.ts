import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type DB } from "../db/client.js";
import {
  isAutomatedSession,
  startSession,
  endSession,
  countPrompt,
  setSessionTitle,
  getSession,
  listSessions,
  listProjects,
} from "./index.js";

describe("session bookkeeping", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb({ path: ":memory:" });
  });

  it("opens a session against a project name", () => {
    // The caller resolves the name; a session stores what it is given. There
    // is one project key in the system and it is the name.
    const s = startSession(db, { id: "s1", project: "reMem" });
    expect(s.id).toBe("s1");
    expect(s.project).toBe("reMem");
    expect(s.projectName).toBe("reMem");
    expect(s.status).toBe("active");
  });

  it("is idempotent: a second open keeps the original start time", () => {
    startSession(db, { id: "s1", ts: 1000, project: "/a/b" });
    startSession(db, { id: "s1", ts: 9999, project: "/a/b" });
    expect(getSession(db, "s1")?.startedTs).toBe(1000);
    expect(listSessions(db)).toHaveLength(1);
  });

  it("keeps the first title rather than overwriting it with a later turn", () => {
    startSession(db, { id: "s1", title: "the opening request" });
    startSession(db, { id: "s1", title: "a later turn" });
    expect(getSession(db, "s1")?.title).toBe("the opening request");
  });

  it("fills in a project learned after the session opened", () => {
    startSession(db, { id: "s1" });
    startSession(db, { id: "s1", project: "reMem" });
    expect(getSession(db, "s1")?.projectName).toBe("reMem");
  });

  it("counts turns", () => {
    startSession(db, { id: "s1" });
    expect(countPrompt(db, "s1")).toBe(1);
    expect(countPrompt(db, "s1")).toBe(2);
    expect(getSession(db, "s1")?.promptCount).toBe(2);
  });

  it("closes a session", () => {
    startSession(db, { id: "s1", ts: 10 });
    endSession(db, "s1", 50);
    const s = getSession(db, "s1");
    expect(s?.status).toBe("completed");
    expect(s?.endedTs).toBe(50);
  });

  it("retitles on request", () => {
    startSession(db, { id: "s1" });
    setSessionTitle(db, "s1", "renamed");
    expect(getSession(db, "s1")?.title).toBe("renamed");
  });

  it("lists newest first and filters by project", () => {
    startSession(db, { id: "old", ts: 1, project: "one" });
    startSession(db, { id: "new", ts: 2, project: "two" });
    expect(listSessions(db).map((s) => s.id)).toEqual(["new", "old"]);
    expect(listSessions(db, { project: "one" }).map((s) => s.id)).toEqual([
      "old",
    ]);
  });

  it("groups projects by most recent activity", () => {
    startSession(db, { id: "a", ts: 1, project: "one" });
    startSession(db, { id: "b", ts: 5, project: "two" });
    startSession(db, { id: "c", ts: 3, project: "one" });
    const projects = listProjects(db);
    expect(projects.map((p) => p.name)).toEqual(["two", "one"]);
    expect(projects.find((p) => p.name === "one")?.sessions).toBe(2);
  });

  it("ignores sessions with no project when listing projects", () => {
    startSession(db, { id: "a", ts: 1 });
    expect(listProjects(db)).toEqual([]);
  });

  it("recognises a session nobody had", () => {
    expect(isAutomatedSession("[cron:abc-123] Nightly crawl")).toBe(true);
    expect(isAutomatedSession("  [cron:abc] indented")).toBe(true);
    expect(isAutomatedSession("<<autonomous-loop-dynamic>>")).toBe(true);
  });

  it("does not mistake someone writing about cron for cron", () => {
    // Anchored at the start for exactly this: the word appearing in a real
    // request must not exclude that request from the belief layer.
    expect(isAutomatedSession("add a [cron:...] entry to the readme")).toBe(
      false,
    );
    expect(isAutomatedSession("why did the cron job fail last night?")).toBe(
      false,
    );
    expect(isAutomatedSession(undefined)).toBe(false);
    expect(isAutomatedSession("")).toBe(false);
  });
});
