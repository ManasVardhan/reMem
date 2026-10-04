#!/usr/bin/env node
// Build a synthetic store, so nothing anyone sees is anyone's real memory.
//
// Every screenshot of a working viewer is a screenshot of whoever's memory it
// was pointed at. That is how five page dumps and a dozen viewer screenshots of
// a real ledger ended up committed in September: the only store on the machine
// was the author's own. A memory product cannot demo itself safely without a
// fake person to be.
//
// This writes fixtures/demo.db: an invented developer, fourteen things she
// said, and beliefs derived from them by the same reducer the real thing uses.
// Two of those beliefs are superseded by later messages, which is the behaviour
// worth filming.
//
//   node scripts/demo-store.mjs          # writes fixtures/demo.db
//   REMEM_DB=fixtures/demo.db npx remem-viewer
//
// The embedder is the hashing one on purpose: it needs no model download, so
// this runs anywhere in under a second and looks the same on every machine.

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ReMemKernel,
  HashingEmbedder,
  FunctionConsolidator,
} from "../dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env.REMEM_DEMO_DB ?? join(root, "fixtures", "demo.db");

const DAY = 86_400_000;

// The arc ends today and runs backwards, rather than sitting at fixed dates.
// Confidence decays with age, so a fixture pinned to real calendar dates slowly
// rots: run it three months later and the older beliefs have faded out of the
// active set, which looks like a bug in a demo rather than the feature it is.
const SPAN_DAYS = 67;
const today = new Date();
today.setHours(9, 30, 0, 0);
const start = today.getTime() - SPAN_DAYS * DAY;

// Hours that look like a working day rather than a cron job.
const HOURS = [9.5, 11.25, 14, 16.5, 10.75, 15.25, 13.5];
const at = (day, i) =>
  start + day * DAY + (HOURS[i % HOURS.length] - 9.5) * 3_600_000;

// Priya Raman, staff engineer, invented entirely. The arc: she changes
// employer, changes her mind about a database, and hardens a deploy rule.
const SAID = [
  [0, "I'm a staff engineer at Stripe, working on the payments API."],
  [
    0,
    "Use pnpm in this repo, not npm. The lockfile is pnpm's and I don't want two.",
  ],
  [1, "Always run the migration tests before you touch anything in billing."],
  [
    3,
    "I'm in Berlin, so anything scheduled before 09:00 UTC is my early morning.",
  ],
  [8, "We're standardising on Postgres for new services. No more Mongo."],
  [16, "Don't deploy on Fridays. We've been burned twice this quarter."],
  [24, "Write commit messages in the imperative. 'Add', not 'Added'."],
  [31, "I left Stripe. I'm at Anthropic now, on the inference team."],
  [31, "Same rules carry over: pnpm, imperative commits, no Friday deploys."],
  [38, "I've moved to Lisbon. Still CET, but my mornings start later now."],
  [45, "The billing migration tests are gone, that service was retired."],
  [
    52,
    "For the new service I want SQLite, not Postgres. It's single-node and it stays that way.",
  ],
  [60, "Keep API docs in the repo, not in Notion. Notion drifts."],
  [67, "Reviews before 11:00 my time are fine now that I'm in Lisbon."],
];

// A scripted consolidator: the same interface the LLM one implements, with the
// judgement replaced by string matching so the fixture is identical every run.
// The reducer downstream is the real one, so what lands in the store is a real
// belief layer, not a mock of one.
function propose({ observations, relevantBeliefs }) {
  const ops = [];
  const find = (predicate) =>
    relevantBeliefs.find((b) => b.predicate === predicate);

  for (const obs of observations) {
    const text = obs.content;
    const evidence = [obs.id];

    if (/staff engineer at Stripe/i.test(text)) {
      ops.push({
        op: "CREATE",
        kind: "fact",
        predicate: "employer",
        value: "Stripe",
        confidence: 0.9,
        evidence,
      });
    } else if (/I'm at Anthropic now/i.test(text)) {
      const prior = find("employer");
      ops.push(
        prior
          ? {
              op: "CONTRADICT",
              beliefId: prior.id,
              newValue: "Anthropic",
              confidence: 0.92,
              evidence,
            }
          : {
              op: "CREATE",
              kind: "fact",
              predicate: "employer",
              value: "Anthropic",
              confidence: 0.92,
              evidence,
            },
      );
    } else if (/standardising on Postgres/i.test(text)) {
      ops.push({
        op: "CREATE",
        kind: "preference",
        predicate: "database",
        value: "Postgres for new services",
        confidence: 0.82,
        evidence,
      });
    } else if (/I want SQLite/i.test(text)) {
      const prior = find("database");
      ops.push(
        prior
          ? {
              op: "CONTRADICT",
              beliefId: prior.id,
              newValue: "SQLite for the new single-node service",
              confidence: 0.84,
              evidence,
            }
          : {
              op: "CREATE",
              kind: "preference",
              predicate: "database",
              value: "SQLite",
              confidence: 0.84,
              evidence,
            },
      );
    } else if (/in Berlin/i.test(text)) {
      ops.push({
        op: "CREATE",
        kind: "fact",
        predicate: "location",
        value: "Berlin",
        confidence: 0.8,
        evidence,
      });
    } else if (/moved to Lisbon/i.test(text)) {
      const prior = find("location");
      ops.push(
        prior
          ? {
              op: "CONTRADICT",
              beliefId: prior.id,
              newValue: "Lisbon",
              confidence: 0.85,
              evidence,
            }
          : {
              op: "CREATE",
              kind: "fact",
              predicate: "location",
              value: "Lisbon",
              confidence: 0.85,
              evidence,
            },
      );
    } else if (/Use pnpm/i.test(text)) {
      ops.push({
        op: "CREATE",
        kind: "preference",
        predicate: "package_manager",
        value: "pnpm, never npm",
        confidence: 0.88,
        evidence,
      });
    } else if (/Don't deploy on Fridays/i.test(text)) {
      ops.push({
        op: "CREATE",
        kind: "rule",
        predicate: "deploy_window",
        value: "No deploys on Friday",
        confidence: 0.86,
        evidence,
      });
    } else if (/Same rules carry over/i.test(text)) {
      const prior = find("deploy_window");
      if (prior) ops.push({ op: "REINFORCE", beliefId: prior.id, evidence });
    } else if (/imperative/i.test(text)) {
      ops.push({
        op: "CREATE",
        kind: "preference",
        predicate: "commit_style",
        value: "Imperative mood",
        confidence: 0.83,
        evidence,
      });
    } else if (/migration tests before/i.test(text)) {
      ops.push({
        op: "CREATE",
        kind: "rule",
        predicate: "billing_tests",
        value: "Run migration tests before touching billing",
        confidence: 0.81,
        evidence,
      });
    } else if (/migration tests are gone/i.test(text)) {
      const prior = find("billing_tests");
      if (prior) {
        ops.push({
          op: "CONTRADICT",
          beliefId: prior.id,
          newValue: "Retired with the billing service",
          confidence: 0.8,
          evidence,
        });
      }
    } else if (/API docs in the repo/i.test(text)) {
      ops.push({
        op: "CREATE",
        kind: "preference",
        predicate: "docs_location",
        value: "In the repo, not Notion",
        confidence: 0.82,
        evidence,
      });
    }
  }
  return ops;
}

async function main() {
  mkdirSync(dirname(out), { recursive: true });
  rmSync(out, { force: true });

  const kernel = new ReMemKernel({
    db: { path: out },
    embedder: new HashingEmbedder({ dim: 256 }),
    consolidator: new FunctionConsolidator(propose),
  });

  // Said, then consolidated, then said again: a belief has to exist before a
  // later message can contradict it, which is the whole point of the fixture.
  const half = Math.ceil(SAID.length / 2);
  for (const [i, [day, content]] of SAID.slice(0, half).entries()) {
    await kernel.observe({
      source: "claude-code",
      actor: "user",
      content,
      ts: at(day, i),
    });
  }
  await kernel.consolidate({ all: true });

  for (const [i, [day, content]] of SAID.slice(half).entries()) {
    await kernel.observe({
      source: "claude-code",
      actor: "user",
      content,
      ts: at(day, half + i),
    });
  }
  await kernel.consolidate({});

  const active = kernel.beliefs({ status: "active" });
  const superseded = kernel.beliefs({ status: "superseded" });
  kernel.close();

  process.stdout.write(
    `wrote ${out}\n` +
      `  ${SAID.length} observations, ${active.length} active beliefs, ${superseded.length} superseded\n\n` +
      `  REMEM_DB=${out} npx remem-viewer\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`demo store failed: ${err?.message ?? err}\n`);
  process.exitCode = 1;
});
