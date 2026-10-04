// A ChatCompleter backed by the Claude Agent SDK, so consolidation inherits the
// auth the user already has for Claude Code instead of demanding a second API
// key. Selection order elsewhere is: explicit config, then this, then OpenAI.
//
// The SDK is an optional peer: imported dynamically so reMem installs and runs
// without it, and callers can fall back to createOpenAICompleter.

import type { ChatMessage } from "./llm.js";

export type ChatCompleter = (messages: ChatMessage[]) => Promise<string>;

// True when the Agent SDK is importable in this process.
const SDK_SPECIFIER = "@anthropic-ai/claude-agent-sdk";

export async function agentSdkAvailable(): Promise<boolean> {
  try {
    await import(SDK_SPECIFIER);
    return true;
  } catch {
    return false;
  }
}

// Flatten the message list into a single prompt. The consolidator's contract is
// one system instruction plus one user payload, so nothing is lost by joining.
function flatten(messages: ChatMessage[]): string {
  return messages
    .map((m) => (m.role === "system" ? m.content : m.content))
    .join("\n\n");
}

export async function createAgentSdkCompleter(): Promise<ChatCompleter> {
  const mod = (await import(SDK_SPECIFIER)) as {
    query: (opts: {
      prompt: string;
      options?: Record<string, unknown>;
    }) => AsyncIterable<{
      type: string;
      result?: string;
      [k: string]: unknown;
    }>;
  };

  return async (messages: ChatMessage[]): Promise<string> => {
    // The SDK launches Claude Code as a child, which inherits this process's
    // environment and fires reMem's hooks. The marker tells them the session is
    // reMem's own, so it is not recorded as something the user said. Restored
    // afterwards because the caller's process is not internal.
    const previous = process.env.REMEM_INTERNAL;
    process.env.REMEM_INTERNAL = "1";
    try {
      // These options are not optional in practice. Left at defaults, query()
      // boots a full Claude Code session: it loads user settings, every plugin,
      // skill and MCP server, and fires the user's own SessionStart hooks. That
      // took over two minutes and produced no result when measured, and it would
      // re-enter reMem's own hooks. Disabling setting sources and MCP servers
      // brings the same call to under five seconds.
      const stream = mod.query({
        prompt: flatten(messages),
        options: {
          maxTurns: 1,
          allowedTools: [],
          settingSources: [],
          mcpServers: {},
          permissionMode: "bypassPermissions",
        },
      });
      let out = "";
      for await (const event of stream) {
        if (event.type === "result" && typeof event.result === "string") {
          out = event.result;
        }
      }
      return out;
    } finally {
      if (previous === undefined) delete process.env.REMEM_INTERNAL;
      else process.env.REMEM_INTERNAL = previous;
    }
  };
}
