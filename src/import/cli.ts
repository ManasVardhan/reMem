#!/usr/bin/env node
// remem-import: bring an existing memory store into reMem.
//
// The common case is `remem-import` with no arguments: it finds claude-mem's
// database, ports everything, and tells you what it did. Everything else is a
// narrowing of that.

import { existsSync } from "node:fs";
import { ReMemKernel } from "../kernel.js";
import { openKernel, openKernelReadOnly, dbPath } from "../mcp/store.js";
import { HashingEmbedder } from "../embed/index.js";
import {
  importClaudeMem,
  findClaudeMemDb,
  CLAUDE_MEM_PATHS,
} from "./claude-mem.js";

interface Args {
  from?: string;
  project?: string;
  since?: number;
  dryRun: boolean;
  quiet: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, quiet: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--from": {
        const value = argv[++i];
        if (value) args.from = value;
        break;
      }
      case "--project": {
        const value = argv[++i];
        if (value) args.project = value;
        break;
      }
      case "--since": {
        const raw = argv[++i] ?? "";
        const days = Number(raw.replace(/d$/, ""));
        args.since = Number.isFinite(days)
          ? Date.now() - days * 86_400_000
          : Date.parse(raw);
        break;
      }
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--quiet":
        args.quiet = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        // A bare path is the source, so `remem-import ~/old.db` works.
        if (arg && !arg.startsWith("-")) args.from = arg;
    }
  }
  return args;
}

const HELP = `remem-import: port an existing memory store into reMem

  remem-import                     find claude-mem and import everything
  remem-import --dry-run           report what would be imported
  remem-import --project reMem     one project only
  remem-import --since 30d         recent history only
  remem-import --from <path>       a claude-mem database somewhere else

What maps to what:
  what you typed      -> the ledger, as observations
  claude-mem's notes  -> episodes, linked to the prompts behind them
  sessions, summaries -> sessions and session episodes

Running it twice imports nothing the second time.
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const source = findClaudeMemDb(args.from);
  if (!source) {
    process.stderr.write(
      `reMem: no claude-mem database found.\nLooked in:\n  ${CLAUDE_MEM_PATHS.join("\n  ")}\nPass a path if it lives elsewhere: remem-import <path>\n`,
    );
    process.exitCode = 1;
    return;
  }

  // A dry run must not create the store, and must still read it: the report
  // says how much is already present, which is the whole reason to run one
  // before committing. So it opens the real store when there is one, and falls
  // back to an empty in-memory kernel only when there is nothing to read.
  const kernel = args.dryRun
    ? existsSync(dbPath())
      ? new ReMemKernel({ db: { path: dbPath(), readonly: true } })
      : openKernelReadOnly()
    : openKernel();
  const embedder = new HashingEmbedder();
  // --quiet drops the progress meter, not the result: a port you cannot see
  // the outcome of is worse than no output at all.
  const progress = (msg: string): void => {
    if (!args.quiet) process.stdout.write(msg);
  };
  const log = (msg: string): void => {
    process.stdout.write(msg);
  };

  progress(`Reading ${source}\n`);
  let lastStage = "";
  const report = await importClaudeMem(kernel.raw, embedder, {
    ...(args.from ? { from: args.from } : {}),
    ...(args.project ? { project: args.project } : {}),
    ...(args.since !== undefined ? { since: args.since } : {}),
    dryRun: args.dryRun,
    onProgress: (stage, done, total) => {
      if (args.quiet) return;
      if (stage !== lastStage) {
        if (lastStage) progress("\n");
        lastStage = stage;
      }
      process.stdout.write(`\r  ${stage}: ${done}/${total}`);
    },
  });
  if (!args.quiet && lastStage) progress("\n");

  kernel.close();

  const verb = report.dryRun ? "Would import" : "Imported";
  log(
    `\n${verb}:\n` +
      `  ${report.observations} observations (what you said)\n` +
      `  ${report.episodes} episodes (what happened)\n` +
      `  ${report.sessions} sessions\n` +
      (report.skippedObservations + report.skippedEpisodes
        ? `  ${report.skippedObservations + report.skippedEpisodes} already present, skipped\n`
        : "") +
      `  across ${report.projects.length} projects\n\n` +
      `Store: ${dbPath()}\n`,
  );
  if (!report.dryRun) {
    log(
      `\nNext: run \`remem-viewer\` to read it back, and beliefs will form from\nthese observations the next time consolidation runs.\n`,
    );
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`reMem import failed: ${message}\n`);
  process.exitCode = 1;
});
