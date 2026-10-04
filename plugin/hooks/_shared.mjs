// Shared helpers for reMem's hooks. Hooks receive a JSON payload on stdin and
// must stay quiet and non-fatal: a memory system that breaks the user's session
// is worse than one that misses an observation.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";

// Consolidation runs a model, and on a Claude Code machine that model is
// reached by launching Claude itself. That nested session fires these same
// hooks, so without a guard reMem records its own consolidation prompts as
// things the user said, and the next pass consolidates those. The marker is
// set on the child process by whichever provider launched it.
export function isInternal() {
  return process.env.REMEM_INTERNAL === "1";
}

// Every hook starts with this. A nested reMem-launched session is not a
// session anyone had.
export function exitIfInternal() {
  if (isInternal()) process.exit(0);
}

export async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

// Claude Code copies only the plugin directory into its own cache, so a hook
// runs from a path with no node_modules above it. A bare `remem-kernel` import
// therefore cannot resolve, however the package was installed. This finds the
// installed package instead, and remembers where it was: the search runs once
// per machine, not once per keystroke.

const CACHE = join(homedir(), ".remem", "kernel-path.json");

// Where the plugin installs the kernel for itself when nothing else supplied
// one. Claude Code copies the plugin into a versioned cache directory and
// installs no dependencies for it, so without somewhere of its own to write,
// the plugin can only work on a machine where someone already ran a global
// npm install. This is that somewhere.
export const RUNTIME = join(homedir(), ".remem", "runtime");

function candidates() {
  const paths = [];

  // A local checkout, for development.
  if (process.env.REMEM_SRC) paths.push(process.env.REMEM_SRC);

  // The copy the plugin fetched for itself, which on a plugin-only install is
  // the one that exists.
  paths.push(join(RUNTIME, "node_modules", "remem-kernel"));

  // Installed as a dependency somewhere above this file.
  try {
    const require = createRequire(import.meta.url);
    paths.push(dirname(require.resolve("remem-kernel/package.json")));
  } catch {
    // Not resolvable from here, which is the normal case for a plugin.
  }

  // The usual homes for a global install, cheapest first. Checking a handful
  // of paths beats shelling out to npm on every hook.
  const node = dirname(process.execPath);
  for (const root of [
    join(node, "..", "lib", "node_modules"),
    "/opt/homebrew/lib/node_modules",
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
    join(homedir(), ".npm-global", "lib", "node_modules"),
    join(homedir(), ".local", "share", "pnpm", "global", "5", "node_modules"),
    join(homedir(), "AppData", "Roaming", "npm", "node_modules"),
  ]) {
    paths.push(join(root, "remem-kernel"));
  }

  return paths;
}

function looksLikeKernel(dir) {
  return Boolean(dir) && existsSync(join(dir, "dist", "index.js"));
}

function findKernel() {
  for (const dir of candidates()) {
    if (looksLikeKernel(dir)) return dir;
  }

  // Last resort: ask the package manager. Slow, so it only ever runs when the
  // package lives somewhere unusual, and the answer is cached below.
  for (const [cmd, args] of [
    ["npm", ["root", "-g"]],
    ["pnpm", ["root", "-g"]],
  ]) {
    try {
      const root = execFileSync(cmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }).trim();
      const dir = join(root, "remem-kernel");
      if (looksLikeKernel(dir)) return dir;
    } catch {
      // Package manager missing or slow. Try the next one.
    }
  }

  return undefined;
}

// How long to trust "there is no kernel here". Short enough that installing one
// takes effect promptly, long enough that a machine without one does not shell
// out to a package manager on every keystroke.
const MISS_TTL_MS = 60_000;

function cachedKernel() {
  // REMEM_SRC is checked before the cache, not inside the search it skips.
  // Otherwise a developer pointing at a local checkout would keep loading
  // whichever installed copy happened to be found first and cached.
  if (process.env.REMEM_SRC && looksLikeKernel(process.env.REMEM_SRC)) {
    return process.env.REMEM_SRC;
  }

  let saved;
  try {
    saved = JSON.parse(readFileSync(CACHE, "utf8"));
  } catch {
    // No cache yet, or it is unreadable.
  }

  if (saved?.root && looksLikeKernel(saved.root)) return saved.root;

  // A remembered miss. Without this, a machine with the plugin installed but
  // not the package re-runs `npm root -g` and `pnpm root -g` on every prompt
  // and every tool call, each with a five second timeout: ten seconds per
  // hook, which is past the timeout the hook is given.
  if (saved?.missAt && Date.now() - saved.missAt < MISS_TTL_MS && !saved.root) {
    return undefined;
  }

  const root = findKernel();

  try {
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(
      CACHE,
      JSON.stringify(root ? { root } : { missAt: Date.now() }, null, 2),
    );
  } catch {
    // Caching is an optimisation. Failing to write it is not failing.
  }
  return root;
}

export function kernelRoot() {
  return cachedKernel();
}

// Resolve a module from the installed reMem package. Every hook and the MCP
// shim go through this so development and installed use resolve the same way.
export async function load(subpath = "index.js") {
  const root = cachedKernel();
  if (!root) {
    throw new Error(
      "cannot find the remem-kernel package. Install it with `npx remem-kernel setup`, or set REMEM_SRC to a checkout.",
    );
  }
  return import(pathToFileURL(join(root, "dist", subpath)).href);
}

// The store this hook would write to. Restated here rather than imported,
// because it is three lines and importing it means loading the kernel before
// deciding whether the fast path is even available.
export function storePath() {
  const override = process.env.REMEM_DB;
  if (override && override.trim() !== "") return resolve(override);
  return join(homedir(), ".remem", "remem.db");
}

// The running viewer, but only if it serves the same store this hook writes to.
//
// A viewer started against a fixture (REMEM_DB=fixtures/demo.db, which is what
// the demo instructions tell people to do) overwrites the one claim file. Left
// unchecked, the hooks then ask it to embed and recall: recall returns someone
// else's memories, and the write path embeds with that store's model and puts
// the result in this one, permanently, in a table that cannot be corrected.
export function viewerClaim() {
  try {
    const claim = JSON.parse(
      readFileSync(join(homedir(), ".remem", "viewer.json"), "utf8"),
    );
    if (!claim?.port) return undefined;
    // An older viewer wrote no db field. Treat that as unknown rather than
    // matching, because guessing wrong here is the expensive direction.
    if (!claim.db || resolve(claim.db) !== storePath()) return undefined;
    return claim;
  } catch {
    return undefined;
  }
}

// The version of the plugin Claude Code is running, which is the version of the
// kernel it was built against.
export function pluginVersion() {
  try {
    const manifest = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      ".claude-plugin",
      "plugin.json",
    );
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

// Fetch the kernel the plugin needs, once, in the background.
//
// Installing a plugin used to leave a person with hooks that could not load
// anything until they also ran a global npm install, and nothing said so: the
// hooks failed politely and memory simply never started. Now the plugin gets
// its own copy. The install runs detached because it takes tens of seconds and
// a hook has a few, and it is never awaited: this session goes on without
// memory, the next one has it.
//
// Returns what happened, so a caller can tell the user something true.
const ATTEMPT = join(RUNTIME, "install-attempt.json");
const RETRY_MS = 6 * 60 * 60 * 1000;

export function bootstrapKernel() {
  let attempt;
  try {
    attempt = JSON.parse(readFileSync(ATTEMPT, "utf8"));
  } catch {
    // No attempt on record.
  }
  if (attempt?.at && Date.now() - attempt.at < RETRY_MS) return "in-flight";

  const version = pluginVersion();
  const spec = version ? `remem-kernel@${version}` : "remem-kernel";

  try {
    mkdirSync(RUNTIME, { recursive: true });
    // npm wants a package.json to install into, and without one it walks up
    // and installs into whatever project happens to be above.
    const manifest = join(RUNTIME, "package.json");
    if (!existsSync(manifest)) {
      writeFileSync(
        manifest,
        JSON.stringify({ name: "remem-runtime", private: true }, null, 2),
      );
    }
    writeFileSync(ATTEMPT, JSON.stringify({ at: Date.now(), spec }, null, 2));

    const child = spawn(
      "npm",
      ["install", "--prefix", RUNTIME, "--no-audit", "--no-fund", spec],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    return "started";
  } catch {
    // No npm, or nowhere to write. Either way the user has to do it.
    return "unavailable";
  }
}

// Hooks never fail the session. Log to stderr, exit 0.
export function survive(err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`reMem hook: ${message}\n`);
  process.exit(0);
}
