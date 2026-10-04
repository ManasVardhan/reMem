#!/usr/bin/env node
// remem-reembed: rebuild the store's vectors with a different embedder.
//
// The default embedder is a hashing trick with no sense of meaning: it matches
// on shared words and nothing else, so a question phrased differently from the
// memory it needs finds nothing, and a question about something absent finds
// whatever happens to be most confident. Moving to a local sentence model fixes
// both, at the cost of a one-time pass over the store and about half a second
// per prompt.

import { openKernel, dbPath } from "../mcp/store.js";
import { createTransformersEmbedder } from "./transformers.js";
import { HashingEmbedder } from "./index.js";
import {
  storeIdentity,
  HASHING_IDENTITY,
  TRANSFORMERS_IDENTITY,
  type EmbedderIdentity,
} from "./select.js";
import { reembed } from "./reembed.js";

const HELP = `remem-reembed: rebuild the store's vectors

  remem-reembed                 move to local sentence embeddings (recommended)
  remem-reembed --to hashing    move back to the dependency-free default
  remem-reembed --status        report what the store holds now

Every observation and belief carries the vector it was written with, and vectors
from two embedders cannot be compared, so this rewrites all of them. Only the
index changes: what was said, when, and what it justifies are untouched.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }

  const kernel = openKernel();
  const db = kernel.raw;
  const current = storeIdentity(db);

  if (argv.includes("--status")) {
    const counts = db
      .prepare(
        `SELECT (SELECT count(*) FROM observation) AS observations,
                (SELECT count(*) FROM belief) AS beliefs`,
      )
      .get() as { observations: number; beliefs: number };
    process.stdout.write(
      `Store:      ${dbPath()}\n` +
        `Embedder:   ${current.name}${current.model ? ` (${current.model})` : ""}, ${current.dim} dimensions\n` +
        `Holds:      ${counts.observations} observations, ${counts.beliefs} beliefs\n` +
        (current.name === "hashing"
          ? `\nHashing matches on shared words only. Run remem-reembed for a local\n` +
            `sentence model, which understands that "hue" and "colour" are the same\n` +
            `question and that an unrelated one has no answer here.\n`
          : ""),
    );
    kernel.close();
    return;
  }

  const toIndex = argv.indexOf("--to");
  const target = toIndex >= 0 ? argv[toIndex + 1] : "transformers";
  if (target !== "hashing" && target !== "transformers") {
    process.stderr.write(`unknown embedder: ${target}\n`);
    process.exitCode = 1;
    kernel.close();
    return;
  }

  let identity: EmbedderIdentity;
  let embedder;
  if (target === "hashing") {
    identity = HASHING_IDENTITY;
    embedder = new HashingEmbedder({ dim: identity.dim });
  } else {
    identity = TRANSFORMERS_IDENTITY;
    process.stdout.write(
      `Loading ${identity.model}. The first run downloads it, once, and caches it.\n`,
    );
    try {
      embedder = await createTransformersEmbedder({
        model: identity.model!,
        dim: identity.dim,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `Could not load the local sentence model: ${message}\n` +
          `Install it with: npm i -g @huggingface/transformers\n`,
      );
      process.exitCode = 1;
      kernel.close();
      return;
    }
  }

  if (current.name === identity.name) {
    process.stdout.write(
      `Already using ${identity.name}. Rebuilding anyway.\n`,
    );
  }

  const started = Date.now();
  const report = await reembed(db, embedder, identity, {
    onProgress: (done, total) => {
      process.stdout.write(`\r  ${done}/${total}`.padEnd(24));
    },
  });
  process.stdout.write("\r".padEnd(26) + "\r");
  kernel.close();

  process.stdout.write(
    `Re-embedded with ${identity.name} in ${((Date.now() - started) / 1000).toFixed(1)}s:\n` +
      `  ${report.observations} observations\n` +
      `  ${report.beliefs} beliefs\n` +
      (report.entities ? `  ${report.entities} entities\n` : "") +
      `\nWhat was said is unchanged. Only the index over it was rebuilt.\n`,
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`reMem reembed failed: ${message}\n`);
  process.exitCode = 1;
});
