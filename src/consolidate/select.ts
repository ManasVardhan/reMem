// Choose a consolidator completer without making the user configure one.
//
// Order: the Agent SDK, then the claude CLI, then the Anthropic API, then any
// OpenAI-compatible endpoint. The first two inherit the auth a Claude Code user
// already has, so the common case needs no key and no configuration.
//
// Returning undefined is a normal outcome, not an error: with no provider the
// caller leaves observations in the ledger for a later pass rather than failing
// the session.

import type { ChatCompleter } from "./llm.js";
import { createOpenAICompleter } from "./llm.js";
import { agentSdkAvailable, createAgentSdkCompleter } from "./agent-sdk.js";
import { anthropicAvailable, createAnthropicCompleter } from "./anthropic.js";
import { claudeCliAvailable, createClaudeCliCompleter } from "./claude-cli.js";

export type CompleterSource =
  | "agent-sdk"
  | "claude-cli"
  | "anthropic"
  | "openai"
  | "none";

export interface SelectedCompleter {
  source: CompleterSource;
  complete?: ChatCompleter;
}

export async function selectCompleter(): Promise<SelectedCompleter> {
  const forced = process.env.REMEM_CONSOLIDATOR_PROVIDER;

  if (
    forced !== "anthropic" &&
    forced !== "openai" &&
    forced !== "claude-cli"
  ) {
    if (await agentSdkAvailable()) {
      return { source: "agent-sdk", complete: await createAgentSdkCompleter() };
    }
  }

  // The SDK is an optional dependency most installs will not have. The CLI is
  // on the PATH of everyone running reMem as a Claude Code plugin, which is the
  // audience whose beliefs are meant to form without them doing anything.
  if (
    forced !== "anthropic" &&
    forced !== "openai" &&
    (await claudeCliAvailable())
  ) {
    return { source: "claude-cli", complete: createClaudeCliCompleter() };
  }

  if (forced !== "openai" && anthropicAvailable()) {
    return { source: "anthropic", complete: createAnthropicCompleter() };
  }

  if (process.env.OPENAI_API_KEY) {
    return { source: "openai", complete: createOpenAICompleter() };
  }

  return { source: "none" };
}
