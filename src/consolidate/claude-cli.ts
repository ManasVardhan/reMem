// A ChatCompleter backed by the `claude` command line tool.
//
// The Agent SDK is the better path when it is installed, but it is a large
// optional dependency and most people install reMem without it. Anyone running
// reMem as a Claude Code plugin already has the CLI on their PATH and already
// signed in, so this makes "beliefs form by themselves" true for them with no
// key to configure and nothing extra to install.

import { spawn } from "node:child_process";
import type { ChatMessage } from "./llm.js";

export type ChatCompleter = (messages: ChatMessage[]) => Promise<string>;

function binary(): string {
  return process.env.REMEM_CLAUDE_BIN ?? "claude";
}

// Whether the CLI is there and runnable. Kept to a version check so it stays
// fast enough to sit in provider selection.
export function claudeCliAvailable(timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      const child = spawn(binary(), ["--version"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        done(false);
      }, timeoutMs);
      child.on("error", () => {
        clearTimeout(timer);
        done(false);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done(code === 0);
      });
    } catch {
      done(false);
    }
  });
}

function flatten(messages: ChatMessage[]): string {
  return messages.map((m) => m.content).join("\n\n");
}

export interface ClaudeCliOptions {
  // Long enough for a large consolidation window, short enough that a wedged
  // session end does not hang teardown forever.
  timeoutMs?: number;
  model?: string;
}

export function createClaudeCliCompleter(
  options: ClaudeCliOptions = {},
): ChatCompleter {
  const timeoutMs = options.timeoutMs ?? 180_000;

  return (messages: ChatMessage[]): Promise<string> =>
    new Promise((resolve, reject) => {
      // Consolidation asks one question and wants one answer. Left at its
      // defaults the child boots the user's whole Claude Code setup: every MCP
      // server, every plugin and their session hooks, with full tool access in
      // whatever directory the session ended in. Measured against the Agent SDK
      // path, that difference was minutes against seconds.
      //
      // So: no MCP servers, no tools, and no session written to disk. The
      // model is being asked to read text and return JSON; it has no use for
      // any of it.
      const args = [
        "-p",
        "--output-format",
        "text",
        "--strict-mcp-config",
        "--allowed-tools",
        "",
        "--no-session-persistence",
      ];
      if (options.model) args.push("--model", options.model);

      // The prompt goes in on stdin, not as an argument: a consolidation window
      // is far larger than any platform's argument limit.
      const child = spawn(binary(), args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          // The child is a Claude Code session, so it fires reMem's own hooks.
          // Without this marker they record the consolidation prompt as
          // something the user said, and the next pass consolidates that: the
          // memory fills up with its own reflection. The hooks check for it and
          // do nothing.
          REMEM_INTERNAL: "1",
        },
      });

      let out = "";
      let err = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        err += chunk.toString();
      });
      child.on("error", (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve(out.trim());
          return;
        }
        reject(
          new Error(
            `claude CLI exited ${code}${err.trim() ? `: ${err.trim().slice(0, 300)}` : ""}`,
          ),
        );
      });

      child.stdin.end(flatten(messages));
    });
}
