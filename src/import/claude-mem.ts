// Porting a claude-mem store into reMem.
//
// The two systems disagree about what an observation is, and the mapping has to
// respect that rather than flatten it:
//
//   claude-mem user_prompts  -> reMem observation   (what was actually said)
//   claude-mem observations  -> reMem episode       (a model's account of work)
//   claude-mem sdk_sessions  -> reMem session
//   claude-mem summaries     -> reMem episode, kind 'session'
//
// claude-mem's observations are model-written summaries, so they are not ledger
// material: putting them in the ledger would mean an immutable record of
// something nobody said. They become episodes, which is what they are.
//
// Every episode is linked to the observations of its session, so provenance
// holds after the port: an imported account still resolves to real prompts.
//
// The import is idempotent. Ids are derived from the source rows, so running it
// twice imports nothing the second time.

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { DB } from "../db/client.js";
import { syncFts } from "../db/client.js";
import type { Embedder } from "../embed/index.js";
import { ingestObservation } from "../ingest/index.js";
import { startSession, endSession } from "../sessions/index.js";
import { putEpisode } from "../episodes/index.js";

// Where claude-mem keeps its store. Checked in order; the first that exists
// wins, so the common case needs no argument at all.
export const CLAUDE_MEM_PATHS = [
  join(homedir(), ".claude-mem", "claude-mem.db"),
  join(homedir(), ".claude", "claude-mem", "claude-mem.db"),
];

export function findClaudeMemDb(explicit?: string): string | undefined {
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  return CLAUDE_MEM_PATHS.find((p) => existsSync(p));
}

// Stable ids from source rows: the same claude-mem row always maps to the same
// reMem row, which is what makes re-running the import a no-op.
function stableId(kind: string, key: string): string {
  const hash = createHash("sha256").update(`${kind}:${key}`).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

export interface ImportOptions {
  // Path to claude-mem.db. Omitted means "find it".
  from?: string;
  // Limit to one project, by claude-mem's project name.
  project?: string;
  // Import only rows newer than this epoch ms.
  since?: number;
  // Report what would happen without writing.
  dryRun?: boolean;
  onProgress?: (stage: string, done: number, total: number) => void;
}

export interface ImportReport {
  source: string;
  sessions: number;
  observations: number;
  episodes: number;
  // Rows that were already present. Counted separately so a second run can say
  // honestly that it imported nothing.
  skippedObservations: number;
  skippedEpisodes: number;
  projects: string[];
  dryRun: boolean;
}

interface CmSession {
  content_session_id: string;
  memory_session_id: string | null;
  project: string;
  user_prompt: string | null;
  started_at_epoch: number;
  completed_at_epoch: number | null;
  status: string;
  custom_title: string | null;
}

interface CmPrompt {
  id: number;
  content_session_id: string;
  prompt_number: number;
  prompt_text: string;
  created_at_epoch: number;
}

interface CmObservation {
  id: number;
  memory_session_id: string;
  prompt_number: number | null;
  project: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  text: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  created_at_epoch: number;
}

interface CmSummary {
  id: number;
  memory_session_id: string;
  prompt_number: number | null;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  files_read: string | null;
  files_edited: string | null;
  created_at_epoch: number;
}

function tableExists(src: Database.Database, name: string): boolean {
  const row = src
    .prepare(
      `SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=@name`,
    )
    .get({ name }) as { n: number };
  return row.n > 0;
}

export async function importClaudeMem(
  db: DB,
  embedder: Embedder,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const source = findClaudeMemDb(options.from);
  if (!source) {
    throw new Error(
      `no claude-mem database found. Looked in:\n  ${CLAUDE_MEM_PATHS.join("\n  ")}\nPass --from <path> if it lives elsewhere.`,
    );
  }

  // Read-only, and on a copy of the connection claude-mem's worker may be
  // holding. We never write to the source.
  const src = new Database(source, { readonly: true, fileMustExist: true });
  const report: ImportReport = {
    source,
    sessions: 0,
    observations: 0,
    episodes: 0,
    skippedObservations: 0,
    skippedEpisodes: 0,
    projects: [],
    dryRun: options.dryRun ?? false,
  };

  try {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (options.project) {
      where.push("project = @project");
      params.project = options.project;
    }
    if (options.since !== undefined) {
      where.push("started_at_epoch >= @since");
      params.since = options.since;
    }
    const sessionWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const sessions = tableExists(src, "sdk_sessions")
      ? (src
          .prepare(
            `SELECT content_session_id, memory_session_id, project, user_prompt,
                    started_at_epoch, completed_at_epoch, status, custom_title
               FROM sdk_sessions ${sessionWhere}
              ORDER BY started_at_epoch ASC`,
          )
          .all(params) as CmSession[])
      : [];

    const projects = new Set<string>();

    // Sessions first: prompts and episodes both hang off them.
    const sessionIdFor = new Map<string, string>(); // content_session_id -> reMem id
    const memoryToContent = new Map<string, string>();
    for (const s of sessions) {
      const id = stableId("session", s.content_session_id);
      sessionIdFor.set(s.content_session_id, id);
      if (s.memory_session_id) {
        memoryToContent.set(s.memory_session_id, s.content_session_id);
      }
      projects.add(s.project);
      if (!options.dryRun) {
        startSession(db, {
          id,
          source: "claude-mem",
          project: s.project,
          ...(s.custom_title || s.user_prompt
            ? { title: (s.custom_title ?? s.user_prompt ?? "").slice(0, 120) }
            : {}),
          ts: s.started_at_epoch,
          meta: {
            importedFrom: "claude-mem",
            contentSessionId: s.content_session_id,
            ...(s.memory_session_id
              ? { memorySessionId: s.memory_session_id }
              : {}),
          },
        });
        if (s.completed_at_epoch) {
          endSession(db, id, s.completed_at_epoch);
        }
      }
      report.sessions += 1;
    }
    options.onProgress?.("sessions", report.sessions, sessions.length);

    // Prompts become ledger observations: they are the one thing in a
    // claude-mem store that the user actually said.
    const promptWhere: string[] = [];
    const promptParams: Record<string, unknown> = {};
    if (sessionIdFor.size > 0) {
      promptWhere.push(
        `content_session_id IN (${[...sessionIdFor.keys()]
          .map((_, i) => `@s${i}`)
          .join(",")})`,
      );
      [...sessionIdFor.keys()].forEach((k, i) => {
        promptParams[`s${i}`] = k;
      });
    }
    const prompts =
      tableExists(src, "user_prompts") && sessionIdFor.size > 0
        ? (src
            .prepare(
              `SELECT id, content_session_id, prompt_number, prompt_text,
                      created_at_epoch
                 FROM user_prompts
                ${promptWhere.length ? `WHERE ${promptWhere.join(" AND ")}` : ""}
                ORDER BY created_at_epoch ASC`,
            )
            .all(promptParams) as CmPrompt[])
        : [];

    const projectOf = new Map<string, string>();
    for (const s of sessions) projectOf.set(s.content_session_id, s.project);

    // An account came from one turn, not from the whole session. claude-mem
    // records which turn, so provenance can say exactly that. The by-time index
    // is the fallback for rows that predate that column.
    const byTurn = new Map<string, string>(); // sessionId:promptNumber -> obs id
    const byTime = new Map<string, Array<{ ts: number; id: string }>>();

    const existing = new Set<string>(
      (
        db
          .prepare(
            `SELECT id FROM observation
              WHERE json_extract(meta, '$.importedFrom') = 'claude-mem'`,
          )
          .all() as Array<{ id: string }>
      ).map((r) => r.id),
    );

    let done = 0;
    for (const p of prompts) {
      const id = stableId("prompt", String(p.id));
      const sessionId = sessionIdFor.get(p.content_session_id);
      const project = projectOf.get(p.content_session_id);
      if (sessionId) {
        byTurn.set(`${sessionId}:${p.prompt_number}`, id);
        const list = byTime.get(sessionId) ?? [];
        list.push({ ts: p.created_at_epoch, id });
        byTime.set(sessionId, list);
      }
      if (existing.has(id)) {
        report.skippedObservations += 1;
        continue;
      }
      if (!options.dryRun) {
        await ingestObservation(db, embedder, {
          id,
          ts: p.created_at_epoch,
          source: "code",
          actor: "user",
          content: p.prompt_text,
          contextSnapshot: {
            surface: "claude-code",
            ...(project ? { project, projectName: project } : {}),
            ...(sessionId ? { sessionId } : {}),
            promptNumber: p.prompt_number,
          },
          meta: {
            importedFrom: "claude-mem",
            sourceId: p.id,
          },
        });
      }
      report.observations += 1;
      done += 1;
      if (done % 200 === 0) {
        options.onProgress?.("observations", done, prompts.length);
      }
    }
    options.onProgress?.("observations", report.observations, prompts.length);

    // The turn an account came from: by recorded turn number when there is one,
    // otherwise the last thing said before it. An account we cannot source to
    // anything is imported without provenance rather than with invented links.
    const sourceFor = (
      sessionId: string | undefined,
      promptNumber: number | null,
      ts: number,
    ): string[] => {
      if (!sessionId) return [];
      if (promptNumber !== null) {
        const exact = byTurn.get(`${sessionId}:${promptNumber}`);
        if (exact) return [exact];
      }
      const turns = byTime.get(sessionId);
      if (!turns || turns.length === 0) return [];
      let best: string | undefined;
      for (const t of turns) {
        if (t.ts <= ts) best = t.id;
        else break;
      }
      return best ? [best] : [turns[0]!.id];
    };

    // claude-mem's observations are a model's account of work done. That is an
    // episode in reMem's vocabulary, not a ledger entry.
    const obsWhere: string[] = [];
    const obsParams: Record<string, unknown> = {};
    if (options.project) {
      obsWhere.push("project = @project");
      obsParams.project = options.project;
    }
    if (options.since !== undefined) {
      obsWhere.push("created_at_epoch >= @since");
      obsParams.since = options.since;
    }
    const cmObs = tableExists(src, "observations")
      ? (src
          .prepare(
            `SELECT id, memory_session_id, project, type, title, subtitle,
                    narrative, text, facts, concepts, files_read, files_modified,
                    prompt_number, created_at_epoch
               FROM observations
              ${obsWhere.length ? `WHERE ${obsWhere.join(" AND ")}` : ""}
              ORDER BY created_at_epoch ASC`,
          )
          .all(obsParams) as CmObservation[])
      : [];

    const existingEpisodes = new Set<string>(
      (
        db
          .prepare(
            `SELECT id FROM episode
              WHERE json_extract(meta, '$.importedFrom') = 'claude-mem'`,
          )
          .all() as Array<{ id: string }>
      ).map((r) => r.id),
    );

    done = 0;
    for (const o of cmObs) {
      const episodeId = stableId("episode", String(o.id));
      if (existingEpisodes.has(episodeId)) {
        report.skippedEpisodes += 1;
        done += 1;
        continue;
      }
      const contentSessionId = memoryToContent.get(o.memory_session_id);
      const sessionId = contentSessionId
        ? sessionIdFor.get(contentSessionId)
        : undefined;
      projects.add(o.project);
      if (!options.dryRun) {
        putEpisode(db, {
          id: episodeId,
          ...(sessionId ? { sessionId } : {}),
          project: o.project,
          ts: o.created_at_epoch,
          kind: o.type,
          title: o.title ?? "(untitled)",
          ...(o.subtitle ? { subtitle: o.subtitle } : {}),
          ...((o.narrative ?? o.text)
            ? { narrative: o.narrative ?? o.text ?? "" }
            : {}),
          facts: parseJsonArray(o.facts),
          concepts: parseJsonArray(o.concepts),
          filesRead: parseJsonArray(o.files_read),
          filesChanged: parseJsonArray(o.files_modified),
          meta: { importedFrom: "claude-mem", sourceId: o.id },
          observationIds: sourceFor(
            sessionId,
            o.prompt_number,
            o.created_at_epoch,
          ),
        });
      }
      report.episodes += 1;
      done += 1;
      if (done % 200 === 0) {
        options.onProgress?.("episodes", done, cmObs.length);
      }
    }

    // Session summaries are the same kind of artefact at a coarser grain.
    const summaries = tableExists(src, "session_summaries")
      ? (src
          .prepare(
            `SELECT id, memory_session_id, project, request, investigated,
                    learned, completed, next_steps, files_read, files_edited,
                    prompt_number, created_at_epoch
               FROM session_summaries
              ${options.project ? "WHERE project = @project" : ""}
              ORDER BY created_at_epoch ASC`,
          )
          .all(
            options.project ? { project: options.project } : {},
          ) as CmSummary[])
      : [];

    for (const s of summaries) {
      const summaryId = stableId("summary", String(s.id));
      if (existingEpisodes.has(summaryId)) {
        report.skippedEpisodes += 1;
        continue;
      }
      const contentSessionId = memoryToContent.get(s.memory_session_id);
      const sessionId = contentSessionId
        ? sessionIdFor.get(contentSessionId)
        : undefined;
      const facts = [
        s.investigated ? `Investigated: ${s.investigated}` : "",
        s.learned ? `Learned: ${s.learned}` : "",
        s.completed ? `Completed: ${s.completed}` : "",
        s.next_steps ? `Next: ${s.next_steps}` : "",
      ].filter(Boolean);
      if (!options.dryRun) {
        putEpisode(db, {
          id: summaryId,
          ...(sessionId ? { sessionId } : {}),
          project: s.project,
          ts: s.created_at_epoch,
          kind: "session",
          title: (s.request ?? "Session summary").slice(0, 160),
          ...(s.completed ? { subtitle: s.completed.slice(0, 240) } : {}),
          ...(s.learned ? { narrative: s.learned } : {}),
          facts,
          concepts: [],
          filesRead: parseJsonArray(s.files_read),
          filesChanged: parseJsonArray(s.files_edited),
          meta: { importedFrom: "claude-mem", sourceId: s.id, summary: true },
          observationIds: sourceFor(
            sessionId,
            s.prompt_number,
            s.created_at_epoch,
          ),
        });
      }
      report.episodes += 1;
    }
    options.onProgress?.("episodes", report.episodes, cmObs.length);

    report.projects = [...projects].sort();
    if (!options.dryRun) syncFts(db);
    return report;
  } finally {
    src.close();
  }
}
