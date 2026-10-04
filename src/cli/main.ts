#!/usr/bin/env node
// remem-kernel: the one command a new user runs.
//
// Installing reMem by hand is four steps across two tools (a marketplace, a
// plugin, an npm runtime, then a check), and every one of them can be half
// done from an earlier attempt. `setup` probes what is already there and does
// only the rest, so running it twice is safe and running it after a failure
// picks up where it stopped.

import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSetup, type DoctorVerdict } from "../setup/run.js";
import { pinKernel } from "../setup/pin.js";
import { parseArgs, shellArgs, timeoutFor } from "./args.js";
import type { Exec } from "../setup/probe.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCTOR = join(HERE, "..", "doctor", "cli.js");
const RUNTIME_DIR = join(homedir(), ".remem", "runtime");
// The file the plugin's hooks resolve the kernel from (plugin/hooks/_shared.mjs).
const KERNEL_CACHE = join(homedir(), ".remem", "kernel-path.json");

const HELP = `remem-kernel: set up and check reMem for Claude Code

  remem-kernel setup             install the plugin and the kernel, then verify
  remem-kernel setup --dry-run   print what setup would do, change nothing
  remem-kernel doctor [...]      check that memory is working (see doctor --help)

Run through npx (npx remem-kernel setup) unless remem-kernel is installed
globally.
  remem-kernel --version         print the version
`;

function version(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(HERE, "..", "..", "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

// Resolves rather than rejects on every outcome, including a binary that is
// not installed, because "claude is missing" is a finding for the planner, not
// a crash. A command that runs past its limit is killed and reported as a
// non-zero exit with a "timed out" line, so setup stops instead of hanging.
const WINDOWS = process.platform === "win32";
const exec: Exec = (cmd, args) =>
  new Promise((done) => {
    const timeout = timeoutFor(cmd, args);
    execFile(
      cmd,
      WINDOWS ? shellArgs(args) : args,
      {
        maxBuffer: 10 * 1024 * 1024,
        timeout,
        killSignal: "SIGTERM",
        shell: WINDOWS,
      },
      (err, stdout, stderr) => {
        if (err !== null && (err as { killed?: unknown }).killed === true) {
          done({
            code: 124,
            stdout: String(stdout),
            stderr: `${cmd} ${args.join(" ")} timed out after ${timeout / 1000} s\n${String(stderr)}`,
          });
          return;
        }
        const code = err === null ? 0 : (err as { code?: unknown }).code;
        done({
          code: typeof code === "number" ? code : code === "ENOENT" ? 127 : 1,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });

// The marketplace source is compared against what Claude Code has registered,
// which stores directories as absolute paths. Resolve it once here so the value
// passed to `marketplace add` and the value compared are the same string.
function marketplaceSource(): string {
  let source = process.env.REMEM_MARKETPLACE_SOURCE ?? "ManasVardhan/reMem";
  if (source === "~" || source.startsWith("~/"))
    source = join(homedir(), source.slice(1));
  if (isAbsolute(source) || source.startsWith(".")) source = resolve(source);
  return source;
}

interface DoctorCheck {
  status?: string;
  name?: string;
  detail?: string;
  fix?: string;
}

// Run doctor for its verdict, and show only what is not ok: a wall of passing
// checks would bury the one line that matters at the end of setup.
async function doctor(): Promise<DoctorVerdict> {
  const r = await exec(process.execPath, [DOCTOR, "--json"]);
  let parsed: {
    status?: unknown;
    checks?: DoctorCheck[];
    kernel?: { root?: unknown; version?: unknown };
    plugin?: { version?: unknown };
  };
  try {
    parsed = JSON.parse(r.stdout) as typeof parsed;
  } catch {
    // Doctor itself broke, which says nothing about whether the install
    // worked. Do not fail setup over it.
    process.stdout.write(
      "    doctor gave no readable result; run `npx remem-kernel doctor` to see why\n",
    );
    return { status: "warn" };
  }
  const status =
    parsed.status === "ok" || parsed.status === "fail" ? parsed.status : "warn";
  for (const c of parsed.checks ?? []) {
    if (c.status === "ok") continue;
    process.stdout.write(
      `    ${c.status ?? "?"}  ${c.name ?? ""}  ${c.detail ?? ""}\n`,
    );
    if (c.fix) process.stdout.write(`          -> ${c.fix}\n`);
  }
  const k = parsed.kernel;
  const p = parsed.plugin;
  return {
    status,
    ...(typeof k?.root === "string" && typeof k.version === "string"
      ? { kernel: { root: k.root, version: k.version } }
      : {}),
    ...(typeof p?.version === "string"
      ? { plugin: { version: p.version } }
      : {}),
  };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));

  switch (parsed.kind) {
    case "version":
      process.stdout.write(`${version()}\n`);
      return 0;
    case "help":
      process.stdout.write(HELP);
      return 0;
    case "usage-error":
      process.stderr.write(`remem-kernel: ${parsed.message}\n\n${HELP}`);
      return 1;
    case "setup": {
      const r = await runSetup({
        exec,
        runtimeDir: RUNTIME_DIR,
        source: marketplaceSource(),
        // REMEM_SETUP_VERSION is a testing override (scripts/smoke-setup.mjs):
        // it picks which published kernel the npm step fetches.
        version: process.env.REMEM_SETUP_VERSION ?? version(),
        versionOverridden: process.env.REMEM_SETUP_VERSION !== undefined,
        dryRun: parsed.dryRun,
        doctor,
        pinKernel: (root) => pinKernel(KERNEL_CACHE, root),
        onLine: (line) => process.stdout.write(`${line}\n`),
      });
      return r.code;
    }
    case "doctor":
      return new Promise((done) => {
        const child = spawn(process.execPath, [DOCTOR, ...parsed.args], {
          stdio: "inherit",
        });
        child.on("exit", (code) => done(code ?? 1));
        child.on("error", () => done(1));
      });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`remem-kernel failed: ${message}\n`);
    process.exitCode = 1;
  },
);
