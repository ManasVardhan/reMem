#!/usr/bin/env node
// Stdio shim for the MCP server.
//
// The plugin directory is copied into Claude Code's own cache, away from the
// package it belongs to, so neither a relative path to dist nor a bare import
// can find the server. This resolves the installed package the same way the
// hooks do and then hands over to it.

import { load } from "../hooks/_shared.mjs";

try {
  await load("mcp/server.js");
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`reMem MCP: ${message}\n`);
  process.exit(1);
}
