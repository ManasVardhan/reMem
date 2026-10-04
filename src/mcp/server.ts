#!/usr/bin/env node
// reMem as an MCP server: the portable read surface, plus an explicit write.
//
// Seven tools, deliberately. decay/forget/export are maintenance and stay out
// of a surface a model picks from; forget in particular is a footgun there.
//
// This file is transport only. The tool logic lives in handlers.ts so it can be
// tested without stdio.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openKernel, projectScope } from "./store.js";
import { TOOLS } from "./tools.js";
import { handleTool, textResult } from "./handlers.js";

const kernel = openKernel();

// Read the version rather than restate it. A hardcoded one here went three
// releases out of date without anything failing, because nothing checks it.
function version(): string {
  try {
    const pkg: unknown = JSON.parse(
      readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "..",
          "..",
          "package.json",
        ),
        "utf8",
      ),
    );
    const value = (pkg as { version?: unknown }).version;
    return typeof value === "string" ? value : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const server = new Server(
  { name: "remem", version: version() },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    return await handleTool(kernel, req.params.name, args, (given) =>
      projectScope(given),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...textResult(`reMem error: ${message}`), isError: true };
  }
});

await server.connect(new StdioServerTransport());
