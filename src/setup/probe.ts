// Gathering the facts `remem-kernel setup` plans from. Deciding what to do with
// them lives in ./plan.ts, which is pure; this is the part that touches the
// machine, kept behind an injected Exec so tests never spawn a real claude.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Probe } from "./plan.js";

// A spawn that fails to start (the binary is missing) must resolve
// {code: 127} rather than throw, so "absent" is just another exit code.
export type Exec = (
  cmd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

function parseArray(json: string): unknown[] | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const MISSING = "<missing>";

// The registered `remem` marketplace, in the same shape normalizeSource
// produces. Any drift between the two formats would read as "registered from
// another source" and trigger a needless remove and reinstall.
export function parseMarketplaces(json: string): string | undefined {
  const entry = parseArray(json)?.find(
    (e): e is Record<string, unknown> =>
      typeof e === "object" &&
      e !== null &&
      (e as { name?: unknown }).name === "remem",
  );
  if (!entry || typeof entry.source !== "string") return undefined;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;
  // An entry with no path or repo must never resolve to the current directory
  // (resolve("") is cwd), or running setup from a reMem checkout would read a
  // broken registration as a match. "<missing>" equals nothing setup wants.
  const repo = str(entry.repo);
  const path = str(entry.path);
  if (entry.source === "github") return `github:${repo || MISSING}`;
  if (entry.source === "directory")
    return `directory:${path ? resolve(path) : MISSING}`;
  // Some other kind (a git URL, say). Report it verbatim so it never equals
  // what setup wants and gets replaced.
  return `${entry.source}:${repo ?? path ?? str(entry.url) ?? ""}`;
}

export function parsePluginInstalled(json: string): boolean {
  return (parseArray(json) ?? []).some(
    (e) =>
      typeof e === "object" &&
      e !== null &&
      (e as { id?: unknown }).id === "remem@remem",
  );
}

function runtimeKernelVersion(runtimeDir: string): string | undefined {
  try {
    const pkg = JSON.parse(
      readFileSync(
        join(runtimeDir, "node_modules", "remem-kernel", "package.json"),
        "utf8",
      ),
    ) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export async function probe(exec: Exec, runtimeDir: string): Promise<Probe> {
  const claude = (await exec("claude", ["--version"])).code === 0;
  const npm = (await exec("npm", ["--version"])).code === 0;

  let marketplaceSource: string | undefined;
  let pluginInstalled = false;
  if (claude) {
    marketplaceSource = parseMarketplaces(
      (await exec("claude", ["plugin", "marketplace", "list", "--json"]))
        .stdout,
    );
    pluginInstalled = parsePluginInstalled(
      (await exec("claude", ["plugin", "list", "--json"])).stdout,
    );
  }
  const kernel = runtimeKernelVersion(runtimeDir);

  return {
    node: process.version,
    claude,
    npm,
    pluginInstalled,
    ...(marketplaceSource !== undefined ? { marketplaceSource } : {}),
    ...(kernel !== undefined ? { runtimeKernelVersion: kernel } : {}),
  };
}
