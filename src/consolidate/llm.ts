import type { BeliefRecord, ObservationRecord } from "../types/index.js";
import type { BeliefOp } from "./ops.js";
import { parseOps } from "./ops.js";
import type { ConsolidationContext, Consolidator } from "./consolidator.js";

// The real, LLM-backed consolidator. It renders the observation window and the
// currently-relevant beliefs into a prompt, asks a model to propose belief ops
// as strict JSON, and hands the raw array to parseOps (which validates and drops
// anything malformed). The model never touches the store: its only power is to
// propose typed, bounded ops that the deterministic reducer then applies. That
// separation is what makes an LLM safe to put on the write path.
//
// The chat call is injected (ChatCompleter) so the class is testable with a
// canned model and provider-agnostic at runtime. A default OpenAI-compatible
// completer is provided for live use (OpenAI, OpenRouter, or any compatible
// endpoint via OPENAI_BASE_URL).

export type ChatRole = "system" | "user";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

// Returns the assistant's raw text response for a chat request. Injecting this
// keeps the consolidator independent of any specific SDK or provider.
export type ChatCompleter = (messages: ChatMessage[]) => Promise<string>;

export interface LLMConsolidatorOptions {
  // The chat function. Defaults to an OpenAI-compatible fetch client configured
  // from the environment (see createOpenAICompleter).
  complete?: ChatCompleter;
  // Extra guidance appended to the system prompt (e.g. domain notes).
  extraInstructions?: string;
}

const SYSTEM_PROMPT = `You maintain a user's long-term memory. You are given recent OBSERVATIONS (immutable logged messages, each with an id) and the user's currently RELEVANT BELIEFS (each with an id, predicate, value, kind, and scope).

Propose a list of belief operations that fold the observations into durable beliefs. Emit ONLY durable, user-specific facts, preferences, habits, goals, or relationships. Ignore small talk, transient state, and one-off remarks.

The ONLY allowed operations (respond with a JSON object {"ops": [ ... ]}):
- CREATE a new belief: {"op":"CREATE","kind":"fact|preference|habit|goal|relationship","predicate":"snake_case_key","value":"short value","scope":{optional dims like surface/project},"confidence":0..1,"evidence":["observationId", ...]}
- REINFORCE an existing belief when an observation agrees with it: {"op":"REINFORCE","beliefId":"...","delta":0..1,"evidence":["observationId"]}
- CONTRADICT an existing belief when its value changed: {"op":"CONTRADICT","beliefId":"...","newValue":"new value","confidence":0..1,"evidence":["observationId"]}
- REFINE an existing belief to narrow its scope: {"op":"REFINE","beliefId":"...","narrowerScope":{dim:value},"evidence":["observationId"]}
- NOOP when nothing durable is present: {"op":"NOOP","reason":"..."}

Rules:
- Reuse an existing beliefId (REINFORCE/CONTRADICT/REFINE) instead of CREATE when the observation is about the same predicate as a relevant belief. Only CREATE when no relevant belief covers it.
- predicate is a stable snake_case key (e.g. home_airport, writing_style, dietary_restriction). value is concise.
- Confidence reflects how directly the user asserted it: 0.85-0.95 for a fact the user states plainly and currently (including the new value in a CONTRADICT), 0.6-0.8 for a clear preference, 0.4-0.6 for something merely implied or inferred.
- evidence must be observation ids from the provided window.
- Output strictly valid JSON. No prose outside the JSON object.`;

function renderBeliefs(beliefs: BeliefRecord[]): string {
  if (beliefs.length === 0) return "(none)";
  return beliefs
    .map((b) => {
      const scope = Object.keys(b.scope).length
        ? ` scope=${JSON.stringify(b.scope)}`
        : "";
      return `- id=${b.id} ${b.kind} ${b.predicate}=${b.value} (confidence ${b.confidence.toFixed(2)})${scope}`;
    })
    .join("\n");
}

function renderObservations(observations: ObservationRecord[]): string {
  if (observations.length === 0) return "(none)";
  return observations
    .map((o) => {
      const surface =
        typeof o.contextSnapshot?.surface === "string"
          ? ` [surface=${o.contextSnapshot.surface}]`
          : "";
      return `- id=${o.id} ${o.actor}${surface}: ${o.content}`;
    })
    .join("\n");
}

// Pull the ops array out of whatever shape the model returned: {"ops":[...]},
// a bare [...], or a fenced code block. Returns [] when nothing parseable is
// found, so a bad response degrades to "no beliefs formed" rather than throwing.
function extractOpsArray(text: string): unknown[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? (fenced[1] as string) : text;
  const trimmed = body.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray((parsed as { ops?: unknown }).ops)) {
      return (parsed as { ops: unknown[] }).ops;
    }
  } catch {
    // Fall through to a lenient array scan below.
  }
  const arrStart = trimmed.indexOf("[");
  const arrEnd = trimmed.lastIndexOf("]");
  if (arrStart !== -1 && arrEnd > arrStart) {
    try {
      const arr = JSON.parse(trimmed.slice(arrStart, arrEnd + 1));
      if (Array.isArray(arr)) return arr;
    } catch {
      // give up
    }
  }
  return [];
}

export class LLMConsolidator implements Consolidator {
  private readonly complete: ChatCompleter;
  private readonly extraInstructions: string;

  constructor(options: LLMConsolidatorOptions = {}) {
    this.complete = options.complete ?? createOpenAICompleter();
    this.extraInstructions = options.extraInstructions ?? "";
  }

  async propose(ctx: ConsolidationContext): Promise<BeliefOp[]> {
    const system = this.extraInstructions
      ? `${SYSTEM_PROMPT}\n\n${this.extraInstructions}`
      : SYSTEM_PROMPT;
    const user = `RELEVANT BELIEFS:\n${renderBeliefs(ctx.relevantBeliefs)}\n\nOBSERVATIONS:\n${renderObservations(ctx.observations)}\n\nRespond with {"ops": [...]}.`;

    const raw = await this.complete([
      { role: "system", content: system },
      { role: "user", content: user },
    ]);
    const { ops } = parseOps(extractOpsArray(raw));
    return ops;
  }
}

export interface OpenAICompleterOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  // Retries on transient failures (network errors, 429, 5xx). Defaults to 4.
  // A long batch job makes thousands of sequential calls, so a single blip
  // should not abort the whole run.
  maxRetries?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A minimal OpenAI-compatible chat completer built on fetch (no SDK dependency).
// Works with OpenAI, OpenRouter, or any compatible /chat/completions endpoint.
// Reads OPENAI_API_KEY, OPENAI_BASE_URL, and OPENAI_MODEL from the environment
// unless overridden. Requests a JSON object response.
export function createOpenAICompleter(
  options: OpenAICompleterOptions = {},
): ChatCompleter {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const baseUrl = (
    options.baseUrl ??
    process.env.OPENAI_BASE_URL ??
    "https://api.openai.com/v1"
  ).replace(/\/$/, "");
  const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const maxRetries = options.maxRetries ?? 4;

  // Resolve temperature: explicit option wins, then env var, then default 0.
  // OPENAI_TEMPERATURE=default omits the field entirely, for reasoning models
  // (gpt-4-turbo, o1, o3, etc.) that reject explicit temperature values.
  let temperature: number | undefined;
  if (options.temperature !== undefined) {
    temperature = options.temperature;
  } else {
    const envTemp = process.env.OPENAI_TEMPERATURE;
    if (envTemp === "default") {
      temperature = undefined;
    } else if (envTemp) {
      const parsed = parseFloat(envTemp);
      temperature = Number.isNaN(parsed) ? 0 : parsed;
    } else {
      temperature = 0;
    }
  }

  return async (messages: ChatMessage[]): Promise<string> => {
    if (!apiKey) {
      throw new Error(
        "LLMConsolidator needs an API key. Set OPENAI_API_KEY (and optionally " +
          "OPENAI_BASE_URL / OPENAI_MODEL), or pass a custom `complete` function.",
      );
    }
    const body = JSON.stringify({
      model,
      ...(temperature !== undefined && { temperature }),
      messages,
      response_format: { type: "json_object" },
    });
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await sleep(Math.min(1000 * 2 ** (attempt - 1), 15000));
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body,
        });
        // Retry rate limits and server errors; fail fast on other 4xx.
        if (res.status === 429 || res.status >= 500) {
          lastError = new Error(
            `chat completion failed (${res.status}): ${await res.text()}`,
          );
          continue;
        }
        if (!res.ok) {
          throw new Error(
            `chat completion failed (${res.status}): ${await res.text()}`,
          );
        }
        const data = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        return data.choices?.[0]?.message?.content ?? "";
      } catch (err) {
        // Network-level failures (fetch failed, ECONNRESET, timeouts) land here.
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}
