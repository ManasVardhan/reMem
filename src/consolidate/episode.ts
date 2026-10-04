// Deriving the account of a session: claude-mem's structured record, produced
// once per session instead of once per tool call.
//
// The split matters. Which files were touched is a fact the ledger already
// knows, so it is computed, not asked for. Only the parts that need judgement
// (what this session was about, what was learned) go to a model, and what comes
// back is validated before it is stored.

import { z } from "zod";
import type { DB } from "../db/client.js";
import type { ChatCompleter } from "./llm.js";
import { readObservations } from "../ingest/index.js";
import { putEpisode } from "../episodes/index.js";
import { getSession } from "../sessions/index.js";
import type { EpisodeRecord, ObservationRecord } from "../types/index.js";

const KINDS = [
  "discovery",
  "feature",
  "bugfix",
  "change",
  "decision",
  "refactor",
] as const;

const proposalSchema = z.object({
  kind: z.enum(KINDS).default("discovery"),
  title: z.string().min(1).max(200),
  subtitle: z.string().max(300).optional(),
  narrative: z.string().max(4000).optional(),
  facts: z.array(z.string().max(400)).max(12).default([]),
  concepts: z.array(z.string().max(60)).max(10).default([]),
});

export type EpisodeProposal = z.infer<typeof proposalSchema>;

const SYSTEM = `You write the record of a work session so a person can find it again months later.

You are given what the user said, in order. Return JSON only:

{
  "kind": "discovery" | "feature" | "bugfix" | "change" | "decision" | "refactor",
  "title": "one specific sentence naming what happened",
  "subtitle": "one sentence of detail",
  "narrative": "a short paragraph on what was done and why",
  "facts": ["concrete, checkable statements worth remembering"],
  "concepts": ["short tags"]
}

Rules:
- Be specific. "Fixed the import" is useless; "Import linked every episode to
  every prompt in its session, now linked to the originating turn" is useful.
- Facts must be things the session establishes, not restatements of the title.
- Never invent a detail that is not in the material. Fewer facts is better than
  invented ones.
- No preamble, no code fences. JSON only.`;

// The material the model sees: what the person said, and nothing else.
//
// The ledger holds the user's own words. An agent's output is not evidence
// about the user, it is evidence about the agent, and a memory built from it
// ends up describing its own behaviour back to itself.
export function renderWindow(observations: ObservationRecord[]): string {
  const lines: string[] = [];
  for (const o of observations) {
    if (o.actor !== "user") continue;
    const text =
      o.content.length > 1200 ? `${o.content.slice(0, 1200)}...` : o.content;
    lines.push(text);
  }
  return lines.join("\n\n");
}

function parseProposal(raw: string): EpisodeProposal | undefined {
  // Models wrap JSON in prose or fences often enough that recovering the object
  // is worth doing rather than discarding an otherwise good answer.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1] ?? raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(body.slice(start, end + 1));
    const result = proposalSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export interface DeriveEpisodeOptions {
  sessionId: string;
  complete: ChatCompleter;
  // Cap on observations sent. A very long session is summarised from its first
  // and last stretches rather than truncated to its opening.
  maxObservations?: number;
}

// Returns undefined when there is nothing worth recording, or when the model's
// answer did not validate. Both are normal: the ledger is unaffected either way.
export async function deriveEpisode(
  db: DB,
  options: DeriveEpisodeOptions,
): Promise<EpisodeRecord | undefined> {
  const all = readObservations(db).filter(
    (o) =>
      o.actor === "user" &&
      (o.contextSnapshot as Record<string, unknown>).sessionId ===
        options.sessionId,
  );
  if (all.length === 0) return undefined;

  const max = options.maxObservations ?? 160;
  const window =
    all.length <= max
      ? all
      : [
          ...all.slice(0, Math.floor(max / 2)),
          ...all.slice(-Math.ceil(max / 2)),
        ];

  const raw = await options.complete([
    { role: "system", content: SYSTEM },
    { role: "user", content: renderWindow(window) },
  ]);
  const proposal = parseProposal(raw);
  if (!proposal) return undefined;

  const session = getSession(db, options.sessionId);
  const last = all[all.length - 1];

  return putEpisode(db, {
    // One account per session, rewritten if the session is consolidated again.
    id: `episode-${options.sessionId}`,
    sessionId: options.sessionId,
    ...(session?.projectName ? { project: session.projectName } : {}),
    ts: last?.ts ?? Date.now(),
    kind: proposal.kind,
    title: proposal.title,
    ...(proposal.subtitle ? { subtitle: proposal.subtitle } : {}),
    ...(proposal.narrative ? { narrative: proposal.narrative } : {}),
    facts: proposal.facts,
    concepts: proposal.concepts,
    // Left empty: the only source for these was a record of the agent's own
    // tool calls, which is no longer kept. Imports still carry theirs.
    filesRead: [],
    filesChanged: [],
    meta: { derivedFrom: "session" },
    // Provenance is the whole session: this account is about all of it.
    observationIds: all.map((o) => o.id),
  });
}
