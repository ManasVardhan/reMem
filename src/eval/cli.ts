import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HashingEmbedder } from "../embed/index.js";
import { syntheticDataset } from "./fixtures.js";
import { fixtureConsolidator } from "./fixtures.js";
import {
  ReMemSystem,
  FullContextSystem,
  NaiveVectorSystem,
  NoMemorySystem,
} from "./systems.js";
import { runEval } from "./runner.js";
import { renderReport } from "./report.js";
import type { MemorySystem } from "./types.js";

// Entry point for `pnpm eval`. Builds the hermetic synthetic dataset, runs the
// three baselines plus ReMem, writes a dated markdown summary plus the raw
// report json under eval/results/<date>/, and echoes the table to stdout so a
// run is legible without opening a file.

async function main(): Promise<void> {
  const embedder = new HashingEmbedder();
  const dataset = syntheticDataset();

  const systems: MemorySystem[] = [
    new NoMemorySystem(),
    new FullContextSystem(),
    new NaiveVectorSystem(embedder),
    new ReMemSystem(embedder, fixtureConsolidator),
  ];

  const report = await runEval(dataset, systems);
  const markdown = renderReport(report);

  const date = new Date(report.generatedTs).toISOString().slice(0, 10);
  const outDir = join(process.cwd(), "eval", "results", date);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "summary.md"), markdown, "utf8");
  writeFileSync(
    join(outDir, "report.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );

  process.stdout.write(markdown);
  process.stdout.write(`\nWrote results to ${outDir}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
