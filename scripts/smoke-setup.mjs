#!/usr/bin/env node
// Smoke test of `remem-kernel setup` against a real Claude Code.
//
// The unit tests drive setup with a fake exec. This runs the real thing: the
// real claude CLI adds the marketplace and installs the plugin, real npm
// fetches the kernel. All of it happens in a throwaway HOME, so the author's
// own Claude Code config and ~/.remem are never touched; the script checks
// that isolation holds before it runs anything that writes.
//
//   pnpm build && node scripts/smoke-setup.mjs [--source <dir>] [--version <v>]
//
// --source  marketplace to install from (default: this repo, whose
//           .claude-plugin/marketplace.json points at ./plugin)
// --version kernel version the npm step fetches (default: package.json). The
//           npm step installs from the registry, so a version that is not
//           published yet cannot be fetched; pass a published one to smoke
//           the rest of setup before a release. Sets REMEM_SETUP_VERSION.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli", "main.js");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const source = resolve(arg("--source") ?? ROOT);
const version = arg("--version");

const home = mkdtempSync(join(tmpdir(), "remem-smoke-setup-"));
const env = {
  ...process.env,
  HOME: home,
  // Claude Code reads its config from here when set; pointing it inside the
  // throwaway HOME means a stray inherited value cannot leak the real one in.
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  REMEM_MARKETPLACE_SOURCE: source,
  npm_config_cache: join(home, ".npm"),
};
if (version) env.REMEM_SETUP_VERSION = version;

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    process.stdout.write(`  ok    ${name}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Every child gets a timeout: a claude that stops to ask for a login would
// otherwise hang the smoke forever.
function run(cmd, args, timeout) {
  const r = spawnSync(cmd, args, { env, encoding: "utf8", timeout });
  if (r.error?.code === "ETIMEDOUT") {
    throw new Error(
      `${cmd} ${args.join(" ")} timed out after ${timeout / 1000}s`,
    );
  }
  if (r.error) throw r.error;
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function indent(text) {
  return text
    .trimEnd()
    .split("\n")
    .map((l) => `        | ${l}`)
    .join("\n");
}

function setup(extra = []) {
  const r = run(process.execPath, [CLI, "setup", ...extra], 300000);
  process.stdout.write(`${indent(r.out)}\n`);
  return r;
}

process.stdout.write(
  `reMem setup smoke test\n  home    ${home}\n  source  ${source}\n` +
    `  version ${version ?? "(package.json)"}\n\n`,
);

try {
  assert(existsSync(CLI), `${CLI} is missing; run pnpm build first`);

  // Isolation first. A temp HOME that Claude Code ignores would mean setup
  // rewrites the author's real plugin config, so nothing below runs unless
  // the temp config is visibly empty.
  const listed = run(
    "claude",
    ["plugin", "marketplace", "list", "--json"],
    30000,
  );
  let isolated = false;
  await check("claude sees an empty config in the throwaway home", () => {
    assert(
      listed.code === 0,
      `exited ${listed.code}: ${listed.out.slice(0, 200)}`,
    );
    const names = JSON.parse(listed.out).map((m) => m.name);
    assert(
      names.length === 0,
      `isolation failed, real marketplaces visible: ${names.join(", ")}`,
    );
    isolated = true;
  });
  if (!isolated)
    throw new Error("aborting: Claude Code is not isolated, setup was not run");

  await check("setup --dry-run plans the marketplace add and install", () => {
    const r = setup(["--dry-run"]);
    assert(r.code === 0, `exited ${r.code}`);
    assert(
      r.out.includes(`plugin marketplace add ${source}`),
      "no marketplace add for the source",
    );
    assert(r.out.includes("plugin install remem@remem"), "no plugin install");
    assert(!existsSync(join(home, ".remem")), "a dry run wrote ~/.remem");
  });

  await check("setup installs into a fresh home and exits 0", () => {
    const r = setup();
    assert(r.code === 0, `exited ${r.code}`);
  });

  await check("claude lists the remem@remem plugin", () => {
    const r = run("claude", ["plugin", "list", "--json"], 30000);
    assert(r.code === 0, `exited ${r.code}`);
    const ids = JSON.parse(r.out).map((p) => p.id);
    assert(
      ids.includes("remem@remem"),
      `plugins: ${ids.join(", ") || "(none)"}`,
    );
  });

  await check("the kernel runtime is installed under ~/.remem/runtime", () => {
    const pkg = join(
      home,
      ".remem",
      "runtime",
      "node_modules",
      "remem-kernel",
      "package.json",
    );
    assert(existsSync(pkg), `${pkg} is missing`);
    const want =
      version ??
      JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
    const got = JSON.parse(readFileSync(pkg, "utf8")).version;
    assert(got === want, `runtime has ${got}, wanted ${want}`);
  });

  await check("setup run a second time exits 0", () => {
    const r = setup();
    assert(r.code === 0, `exited ${r.code}`);
    assert(
      r.out.includes("refresh the reMem marketplace"),
      "did not see the existing marketplace",
    );
    assert(
      !r.out.includes("fetch the reMem kernel"),
      "fetched the kernel again",
    );
  });
} catch (err) {
  failures += 1;
  process.stdout.write(`  FAIL  ${err.message}\n`);
} finally {
  rmSync(home, { recursive: true, force: true });
}

process.stdout.write(
  `\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
