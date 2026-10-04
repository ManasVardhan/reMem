// Argument parsing and per-command limits for remem-kernel, kept apart from
// ./main.ts (which runs on import) so they can be tested without spawning.

export type Command =
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "setup"; dryRun: boolean }
  | { kind: "doctor"; args: string[] }
  | { kind: "usage-error"; message: string };

const SETUP_FLAGS = new Set(["--dry-run"]);

export function parseArgs(argv: string[]): Command {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v") return { kind: "version" };
  if (command === undefined || command === "--help" || command === "-h")
    return { kind: "help" };
  if (command === "setup") {
    // A typo like `--dryrun` must not fall through to a real install.
    const unknown = rest.find((a) => !SETUP_FLAGS.has(a));
    if (unknown !== undefined)
      return {
        kind: "usage-error",
        message: `unknown argument to setup: ${unknown}`,
      };
    return { kind: "setup", dryRun: rest.includes("--dry-run") };
  }
  if (command === "doctor") return { kind: "doctor", args: rest };
  return { kind: "usage-error", message: `unknown command: ${command}` };
}

// How long one external command may run before setup gives up on it. npm
// install fetches a package tree and can be slow on a cold cache; every claude
// call is local bookkeeping or a single clone. A hung child would otherwise
// hang setup with no output.
export function timeoutFor(cmd: string, args: string[]): number {
  if (cmd === "npm" && args[0] === "install") return 600_000;
  return 120_000;
}

// On Windows `claude` and `npm` are .cmd shims that execFile cannot start
// without a shell. With a shell the arguments are joined into one command
// line, so quote any that contain spaces (a runtime dir under a profile path).
export function shellArgs(args: string[]): string[] {
  return args.map((a) => (/\s/.test(a) ? `"${a}"` : a));
}
