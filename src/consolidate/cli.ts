#!/usr/bin/env node
// remem-consolidate: turn observations into beliefs, on demand.
//
// Consolidation normally runs by itself when a session ends. This is the hand
// crank: after importing history, or when a session ended without a provider
// configured, run it to catch the belief layer up with the ledger.

import { openKernel, dbPath } from "../mcp/store.js";
import { selectCompleter } from "./select.js";
import { LLMConsolidator } from "./llm.js";
import { getWatermark } from "./index.js";
import { isAutomatedSession } from "../sessions/index.js";

interface Args {
  all: boolean;
  project?: string;
  sessions?: number;
  batch?: number;
  onlyTyped: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { all: false, onlyTyped: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--all":
        args.all = true;
        break;
      case "--project": {
        const v = argv[++i];
        if (v) args.project = v;
        break;
      }
      case "--sessions": {
        const v = Number(argv[++i]);
        if (Number.isFinite(v)) args.sessions = v;
        break;
      }
      case "--only-typed":
        args.onlyTyped = true;
        break;
      case "--batch": {
        const v = Number(argv[++i]);
        if (Number.isFinite(v)) args.batch = v;
        break;
      }
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        break;
    }
  }
  return args;
}

const HELP = `remem-consolidate: derive beliefs from the ledger

  remem-consolidate                 everything new since the last pass
  remem-consolidate --all           the whole ledger, from the beginning
  remem-consolidate --sessions 20   the 20 most recent sessions, one pass each
  remem-consolidate --project reMem one project only
  remem-consolidate --batch 80      observations per model call (default 120)
  remem-consolidate --only-typed    skip scheduled runs, which are included by default

Each pass sends a window of observations to a model, which proposes typed
belief operations. A deterministic reducer decides what actually happens to
the belief layer, so the model never writes to it directly.
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const { source, complete } = await selectCompleter();
  if (!complete) {
    process.stderr.write(
      "reMem: no model provider available.\n" +
        "Consolidation needs one of: Claude Code (the Agent SDK), ANTHROPIC_API_KEY,\n" +
        "or OPENAI_API_KEY. The ledger is unaffected; run this again once one is set.\n",
    );
    process.exitCode = 1;
    return;
  }

  const kernel = openKernel(new LLMConsolidator({ complete }));
  const before = {
    active: kernel.beliefs({ status: "active" }).length,
    superseded: kernel.beliefs({ status: "superseded" }).length,
  };

  process.stdout.write(`Consolidating via ${source}\n`);
  process.stdout.write(`Store: ${dbPath()}\n`);

  const totals = {
    created: 0,
    reinforced: 0,
    contradicted: 0,
    refined: 0,
    nooped: 0,
    dropped: 0,
    invalid: 0,
  };
  const add = (r: typeof totals): void => {
    totals.created += r.created;
    totals.reinforced += r.reinforced;
    totals.contradicted += r.contradicted;
    totals.refined += r.refined;
    totals.nooped += r.nooped;
    totals.dropped += r.dropped;
    totals.invalid += r.invalid;
  };

  try {
    if (args.sessions !== undefined) {
      // Session at a time, newest first. A session is a coherent window: the
      // things said in it are about each other, which is the context a
      // consolidator needs to tell a correction from a new fact.
      // Scheduled runs are consolidated by default: a routine's instructions
      // say real things about what the user is doing and how they want it done.
      // --only-typed is there for a store where they are pure noise.
      const candidates = kernel.sessions({
        limit: args.onlyTyped ? args.sessions * 4 : args.sessions,
        ...(args.project ? { project: args.project } : {}),
      });
      // Count only what was passed over on the way to filling the request.
      // Counting the whole over-fetched pool reported "skipping 15" when five
      // slots were ever at stake.
      const wanted = args.sessions;
      const kept: typeof candidates = [];
      let skipped = 0;
      for (const session of candidates) {
        if (kept.length >= wanted) break;
        if (args.onlyTyped && isAutomatedSession(session.title)) {
          skipped += 1;
          continue;
        }
        kept.push(session);
      }
      const sessions = kept.reverse();

      if (skipped > 0) {
        process.stdout.write(`Skipping ${skipped} scheduled session(s).\n`);
      }

      let done = 0;
      for (const session of sessions) {
        done += 1;
        process.stdout.write(
          `\r  session ${done}/${sessions.length}: ${(session.title ?? session.id).slice(0, 48)}`.padEnd(
            78,
          ),
        );
        const report = await kernel.consolidate({
          sessionId: session.id,
          ...(args.batch !== undefined ? { batchSize: args.batch } : {}),
        });
        add(report);
      }
      process.stdout.write("\n");
    } else {
      const watermark = getWatermark(kernel.raw);
      if (!args.all && watermark) {
        process.stdout.write(
          `Picking up after observation ${watermark.rowid}\n`,
        );
      }
      const report = await kernel.consolidate({
        all: args.all,
        ...(args.batch !== undefined ? { batchSize: args.batch } : {}),
      });
      add(report);
    }
  } finally {
    const after = {
      active: kernel.beliefs({ status: "active" }).length,
      superseded: kernel.beliefs({ status: "superseded" }).length,
    };
    kernel.close();

    process.stdout.write(
      `\nOperations:\n` +
        `  ${totals.created} created  ${totals.reinforced} reinforced  ` +
        `${totals.contradicted} contradicted  ${totals.refined} refined\n` +
        `  ${totals.nooped} noop  ${totals.dropped} below the confidence floor  ` +
        `${totals.invalid} invalid\n\n` +
        `Beliefs: ${before.active} -> ${after.active} active, ` +
        `${before.superseded} -> ${after.superseded} superseded\n`,
    );
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`reMem consolidate failed: ${message}\n`);
  process.exitCode = 1;
});
