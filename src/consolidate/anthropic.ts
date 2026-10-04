// A ChatCompleter for the Anthropic Messages API.
//
// This is the fast path for consolidation. It is a single HTTPS request, in
// contrast to the Agent SDK, which boots a full Claude Code session (loading
// tools, MCP servers, plugins, and firing the user's own hooks) before it will
// answer. That cost is acceptable for an interactive agent and is not
// acceptable for a batched write-path job.
//
// Auth comes from ANTHROPIC_API_KEY. No key means no consolidator, and the
// caller leaves observations in the ledger for a later pass.

import type { ChatMessage, ChatCompleter } from "./llm.js";

export interface AnthropicOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
}

export function anthropicAvailable(): boolean {
  const key = process.env.ANTHROPIC_API_KEY;
  return typeof key === "string" && key.trim() !== "";
}

export function createAnthropicCompleter(
  options: AnthropicOptions = {},
): ChatCompleter {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
  const model =
    options.model ??
    process.env.REMEM_CONSOLIDATOR_MODEL ??
    "claude-haiku-4-5-20251001";
  const baseUrl =
    options.baseUrl ??
    process.env.ANTHROPIC_BASE_URL ??
    "https://api.anthropic.com";
  const maxTokens = options.maxTokens ?? 2048;

  return async (messages: ChatMessage[]): Promise<string> => {
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

    // The Messages API takes system separately from the turn list.
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const turns = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: "user" as const, content: m.content }));

    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0,
        ...(system ? { system } : {}),
        messages: turns.length ? turns : [{ role: "user", content: "" }],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Anthropic API ${res.status}: ${detail.slice(0, 200)}`);
    }

    const body = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    return (body.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("");
  };
}
