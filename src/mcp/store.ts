// Shared kernel construction for every reMem entry point (MCP server, hooks,
// viewer). One store per machine, scoped internally by project and surface, so
// a belief about the user follows them across repos while a belief about a repo
// does not leak out of it.

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { ReMemKernel } from "../kernel.js";
import {
  selectEmbedder,
  storeIdentity,
  type EmbedderIdentity,
} from "../embed/select.js";
import type { Embedder } from "../embed/index.js";
import type { Consolidator } from "../consolidate/consolidator.js";

// Resolve the on-disk location of the single shared store. REMEM_DB overrides
// for tests and for users who keep their memory elsewhere.
export function dbPath(): string {
  const override = process.env.REMEM_DB;
  if (override && override.trim() !== "") return override;
  const dir = join(homedir(), ".remem");
  // Creating the directory here rather than at first write keeps every caller
  // from having to think about it. The database file itself is still only
  // created by something that actually opens it for writing.
  mkdirSync(dir, { recursive: true });
  return join(dir, "remem.db");
}

// The project dimension of scope.
//
// The name, not the path. A belief formed in a repository should still hold
// after that repository is moved or cloned somewhere else, and the model that
// proposes beliefs reaches for the name anyway. It is also the only key an
// import from another tool can supply, since those stores record a name and
// never a working directory.
//
// The cost is that two checkouts of the same repository share a scope. That is
// the right trade: they are the same project.
export function projectScope(
  cwd: string | undefined = process.env.REMEM_PROJECT,
): string | undefined {
  const value = cwd ?? process.cwd();
  if (!value || value.trim() === "") return undefined;
  const parts = value.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

// The absolute location, kept beside the scope for display and for anything
// that genuinely needs the path rather than the identity.
export function projectPath(
  cwd: string | undefined = process.env.REMEM_PROJECT,
): string | undefined {
  const value = cwd ?? process.cwd();
  return value && value.trim() !== "" ? value : undefined;
}

// Kept as the name the viewer and hooks already call. Same value as the scope:
// there is one project key, and this is it.
export function projectName(cwd: string | undefined): string | undefined {
  return projectScope(cwd);
}

// A kernel over a throwaway in-memory database, for work that must not touch
// the real store: a dry run reports what would happen and leaves no trace.
// Prompts a routine submits that carry no marker of their own, one prefix per
// entry. Another tool's export is the usual reason: it recorded a cron's
// instructions as an ordinary prompt and nothing in the text says otherwise.
//
// A missing or malformed file means no extra prefixes, never an error: this is
// read on the prompt path and must not be able to break a session.
export function scheduledPrefixes(): string[] {
  const path = join(dirname(dbPath()), "scheduled.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(parsed)) {
      return parsed.filter((p): p is string => typeof p === "string");
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { prefixes?: unknown }).prefixes)
    ) {
      return (parsed as { prefixes: unknown[] }).prefixes.filter(
        (p): p is string => typeof p === "string",
      );
    }
  } catch {
    // No file, or not readable as a list. Both mean "nothing extra".
  }
  return [];
}

export function openKernelReadOnly(): ReMemKernel {
  return new ReMemKernel({ db: { path: ":memory:" } });
}

export function openKernel(consolidator?: Consolidator): ReMemKernel {
  return new ReMemKernel({
    db: { path: dbPath() },
    ...(consolidator ? { consolidator } : {}),
  });
}

// A kernel over a caller-supplied embedder, for when the caller has a cheaper
// way to get vectors than loading a model of its own. The onus is on them to
// supply one that matches the store: see openMatchedKernel for the safe path.
export async function openKernelWith(
  embedder: Embedder,
  consolidator?: Consolidator,
): Promise<{ kernel: ReMemKernel; identity: EmbedderIdentity }> {
  const probe = new ReMemKernel({ db: { path: dbPath() } });
  let identity: EmbedderIdentity;
  try {
    identity = storeIdentity(probe.raw);
  } finally {
    probe.close();
  }
  return {
    kernel: new ReMemKernel({
      db: { path: dbPath() },
      embedder,
      scheduledPrefixes: scheduledPrefixes(),
      ...(consolidator ? { consolidator } : {}),
    }),
    identity,
  };
}

// A kernel whose embedder matches the one the store was written with.
//
// Everything that reads or writes vectors has to go through this. Constructing
// a kernel with the default embedder against a store written by another one
// does not fail; it silently compares incomparable numbers, and recall returns
// noise that looks like an answer.
//
// Returns the warning to show when the store's embedder could not be loaded, so
// the caller can say so rather than pretending the results are good.
export async function openMatchedKernel(consolidator?: Consolidator): Promise<{
  kernel: ReMemKernel;
  identity: EmbedderIdentity;
  degraded?: string;
}> {
  const probe = new ReMemKernel({ db: { path: dbPath() } });
  let selected;
  try {
    selected = await selectEmbedder(probe.raw);
  } finally {
    probe.close();
  }

  const kernel = new ReMemKernel({
    db: { path: dbPath() },
    embedder: selected.embedder,
    scheduledPrefixes: scheduledPrefixes(),
    ...(consolidator ? { consolidator } : {}),
  });
  return selected.degraded
    ? { kernel, identity: selected.identity, degraded: selected.degraded }
    : { kernel, identity: selected.identity };
}
