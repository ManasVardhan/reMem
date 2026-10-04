import type { ObservationInput } from "../types/index.js";

// Maps a LoCoMo-style multi-session dialogue into the Observation stream the
// kernel ingests. LoCoMo groups turns into timestamped sessions; each turn
// becomes one observation, with the session carried through as context and meta
// so later phases can reason about session boundaries.
//
// This mapper is intentionally tolerant of the exact field names LoCoMo uses
// across releases (speaker/agent, text/utterance, etc.) so a schema tweak in the
// dataset does not break ingestion.

export interface LocomoTurn {
  speaker?: string;
  agent?: string;
  text?: string;
  utterance?: string;
  ts?: number;
}

export interface LocomoSession {
  session_id?: string | number;
  id?: string | number;
  timestamp?: number;
  turns?: LocomoTurn[];
  dialogue?: LocomoTurn[];
}

export interface LocomoDialogue {
  id?: string | number;
  sessions?: LocomoSession[];
}

// The user's assistant is the "assistant" actor; every other speaker is treated
// as the "user" side of the conversation for ledger purposes.
function actorFor(speaker: string | undefined): "user" | "assistant" {
  if (!speaker) return "user";
  return /assistant|agent|bot/i.test(speaker) ? "assistant" : "user";
}

export function locomoToObservations(
  dialogue: LocomoDialogue,
): ObservationInput[] {
  const out: ObservationInput[] = [];
  const sessions = dialogue.sessions ?? [];

  sessions.forEach((session, sessionIdx) => {
    const sessionId = String(session.session_id ?? session.id ?? sessionIdx);
    const baseTs = session.timestamp ?? sessionIdx;
    const turns = session.turns ?? session.dialogue ?? [];

    turns.forEach((turn, turnIdx) => {
      const speaker = turn.speaker ?? turn.agent;
      const content = turn.text ?? turn.utterance ?? "";
      if (content.length === 0) return;

      out.push({
        // Preserve ordering even when the dataset lacks per-turn timestamps.
        ts: turn.ts ?? baseTs + turnIdx,
        source: "slack",
        actor: actorFor(speaker),
        content,
        contextSnapshot: {
          surface: "locomo",
          session: sessionId,
        },
        meta: {
          dataset: "locomo",
          dialogueId: dialogue.id !== undefined ? String(dialogue.id) : null,
          sessionId,
          turnIndex: turnIdx,
          speaker: speaker ?? null,
        },
      });
    });
  });

  return out;
}
