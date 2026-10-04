// The full storage schema. A single embedded SQLite database is the source of
// truth. The "graph" is just the edge table; vectors are stored as blobs on the
// row they belong to (sqlite-vec virtual tables for KNN recall arrive in the
// recall phase). Beliefs, entities, and edges are created now so the foundation
// is complete even though Phase 1 only writes observations.
//
// Ledger-is-sacred is enforced in the database itself: triggers reject UPDATE
// and DELETE on observation. Privileged user-erasure (GDPR) is a separate path
// that drops these triggers under an explicit flag; it is not exposed here.

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS observation (
  id               TEXT PRIMARY KEY,
  ts               INTEGER NOT NULL,
  source           TEXT NOT NULL,
  actor            TEXT NOT NULL,
  content          TEXT NOT NULL,
  embedding        BLOB NOT NULL,
  context_snapshot TEXT NOT NULL DEFAULT '{}',
  meta             TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_observation_ts ON observation(ts);
CREATE INDEX IF NOT EXISTS idx_observation_source ON observation(source);

CREATE TRIGGER IF NOT EXISTS observation_no_update
BEFORE UPDATE ON observation
BEGIN
  SELECT RAISE(ABORT, 'observation is append-only');
END;

CREATE TRIGGER IF NOT EXISTS observation_no_delete
BEFORE DELETE ON observation
BEGIN
  SELECT RAISE(ABORT, 'observation is append-only');
END;

CREATE TABLE IF NOT EXISTS belief (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL,
  subject             TEXT NOT NULL,
  predicate           TEXT NOT NULL,
  value               TEXT NOT NULL,
  confidence          REAL NOT NULL,
  scope               TEXT NOT NULL DEFAULT '{}',
  created_ts          INTEGER NOT NULL,
  last_reinforced_ts  INTEGER NOT NULL,
  decay_rate          REAL NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active',
  embedding           BLOB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_belief_subject ON belief(subject);
CREATE INDEX IF NOT EXISTS idx_belief_predicate ON belief(predicate);
CREATE INDEX IF NOT EXISTS idx_belief_status ON belief(status);

CREATE TABLE IF NOT EXISTS entity (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  aliases     TEXT NOT NULL DEFAULT '[]',
  attributes  TEXT NOT NULL DEFAULT '{}',
  embedding   BLOB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entity_type ON entity(type);

CREATE TABLE IF NOT EXISTS edge (
  src_id  TEXT NOT NULL,
  dst_id  TEXT NOT NULL,
  type    TEXT NOT NULL,
  weight  REAL NOT NULL DEFAULT 1.0,
  ts      INTEGER NOT NULL,
  PRIMARY KEY (src_id, dst_id, type)
);

CREATE INDEX IF NOT EXISTS idx_edge_src ON edge(src_id);
CREATE INDEX IF NOT EXISTS idx_edge_dst ON edge(dst_id);

-- provenance: every belief points to the observations that justify it.
CREATE TABLE IF NOT EXISTS provenance (
  belief_id       TEXT NOT NULL,
  observation_id  TEXT NOT NULL,
  PRIMARY KEY (belief_id, observation_id)
);

CREATE INDEX IF NOT EXISTS idx_provenance_belief ON provenance(belief_id);

-- A session is the container a batch of observations arrived in: one Claude
-- Code session, one chat, one import run. It is bookkeeping over the ledger,
-- not a second source of truth, so it may be updated freely.
CREATE TABLE IF NOT EXISTS session (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL DEFAULT 'claude-code',
  project       TEXT,
  project_name  TEXT,
  title         TEXT,
  started_ts    INTEGER NOT NULL,
  ended_ts      INTEGER,
  status        TEXT NOT NULL DEFAULT 'active',
  prompt_count  INTEGER NOT NULL DEFAULT 0,
  meta          TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_session_started ON session(started_ts DESC);
CREATE INDEX IF NOT EXISTS idx_session_project ON session(project);
CREATE INDEX IF NOT EXISTS idx_session_status ON session(status);

-- An episode is a derived, structured account of one unit of work: the record
-- a person actually wants to read back. Derived means re-derivable, so unlike
-- an observation it can be rewritten, and like a belief it must resolve to the
-- observations that justify it.
CREATE TABLE IF NOT EXISTS episode (
  id            TEXT PRIMARY KEY,
  session_id    TEXT,
  project       TEXT,
  ts            INTEGER NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'discovery',
  title         TEXT NOT NULL,
  subtitle      TEXT,
  narrative     TEXT,
  facts         TEXT NOT NULL DEFAULT '[]',
  concepts      TEXT NOT NULL DEFAULT '[]',
  files_read    TEXT NOT NULL DEFAULT '[]',
  files_changed TEXT NOT NULL DEFAULT '[]',
  meta          TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_episode_ts ON episode(ts DESC);
CREATE INDEX IF NOT EXISTS idx_episode_session ON episode(session_id);
CREATE INDEX IF NOT EXISTS idx_episode_project ON episode(project);
CREATE INDEX IF NOT EXISTS idx_episode_kind ON episode(kind);

CREATE TABLE IF NOT EXISTS episode_provenance (
  episode_id     TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  PRIMARY KEY (episode_id, observation_id)
);

CREATE INDEX IF NOT EXISTS idx_episode_provenance_episode
  ON episode_provenance(episode_id);

-- Small bookkeeping values that belong to the store rather than to any record
-- in it: where consolidation got to, which schema wrote it. Not memory.
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Session and project live in the observation's context snapshot rather than in
-- columns, because the ledger's shape is fixed and context is open. Expression
-- indexes keep the viewer's two hottest filters fast anyway.
CREATE INDEX IF NOT EXISTS idx_observation_session
  ON observation(json_extract(context_snapshot, '$.sessionId'));
CREATE INDEX IF NOT EXISTS idx_observation_project
  ON observation(json_extract(context_snapshot, '$.project'));
-- Beliefs scope by absolute path so a belief about a repo cannot leak between
-- checkouts. People group by name. Both are carried; this indexes the one the
-- viewer and the search box filter on.
CREATE INDEX IF NOT EXISTS idx_observation_project_name
  ON observation(json_extract(context_snapshot, '$.projectName'));
`;

// Full-text search. Kept apart from SCHEMA_SQL because an FTS5 build is not
// guaranteed on every SQLite: search degrades to a scan rather than the whole
// store failing to open. Both indexes are derived and can be dropped and
// rebuilt from the tables they shadow at any time.
export const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS observation_fts USING fts5(
  content,
  content='observation',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS observation_fts_ai AFTER INSERT ON observation BEGIN
  INSERT INTO observation_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS episode_fts USING fts5(
  title, subtitle, narrative, facts, concepts,
  content='episode',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS episode_fts_ai AFTER INSERT ON episode BEGIN
  INSERT INTO episode_fts(rowid, title, subtitle, narrative, facts, concepts)
  VALUES (new.rowid, new.title, new.subtitle, new.narrative, new.facts, new.concepts);
END;

CREATE TRIGGER IF NOT EXISTS episode_fts_ad AFTER DELETE ON episode BEGIN
  INSERT INTO episode_fts(episode_fts, rowid, title, subtitle, narrative, facts, concepts)
  VALUES ('delete', old.rowid, old.title, old.subtitle, old.narrative, old.facts, old.concepts);
END;

CREATE TRIGGER IF NOT EXISTS episode_fts_au AFTER UPDATE ON episode BEGIN
  INSERT INTO episode_fts(episode_fts, rowid, title, subtitle, narrative, facts, concepts)
  VALUES ('delete', old.rowid, old.title, old.subtitle, old.narrative, old.facts, old.concepts);
  INSERT INTO episode_fts(rowid, title, subtitle, narrative, facts, concepts)
  VALUES (new.rowid, new.title, new.subtitle, new.narrative, new.facts, new.concepts);
END;
`;
