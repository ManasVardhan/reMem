import type { EvalDataset } from "./types.js";

// Registry of external benchmarks (BENCHMARKS.md 2-4). These are real,
// LLM-judged datasets that need network access and a model to score answer
// correctness, so they never run in CI. This module documents them with pinned
// URLs and checksums and exposes a fetch that deliberately refuses to run
// without an explicit opt-in, keeping the hermetic synthetic path (fixtures.ts)
// the default.

export interface ExternalDataset {
  name: string;
  // What memory ability the dataset primarily stresses, for cross-referencing
  // with the synthetic slices.
  focus: string;
  // Pinned source. Kept as data, not fetched at import time.
  url: string;
  // SHA-256 of the release artifact, verified after download so a moved or
  // mutated file is caught rather than silently scored.
  sha256: string;
  license: string;
}

// Pinned registry. Checksums are placeholders until the artifacts are first
// downloaded and recorded; loadExternalDataset refuses to proceed while a
// checksum is unset, so a stale hash cannot pass silently.
export const EXTERNAL_DATASETS: Record<string, ExternalDataset> = {
  longmemeval: {
    name: "LongMemEval",
    focus: "long-horizon extraction and knowledge updates across sessions",
    url: "https://github.com/xiaowu0162/LongMemEval",
    sha256: "",
    license: "see upstream repository",
  },
  locomo: {
    name: "LoCoMo",
    focus: "very long multi-session conversational memory QA",
    url: "https://github.com/snap-research/locomo",
    sha256: "",
    license: "see upstream repository",
  },
  prefeval: {
    name: "PrefEval",
    focus: "preference adherence and scope routing",
    url: "https://github.com/amazon-science/PrefEval",
    sha256: "",
    license: "see upstream repository",
  },
};

export interface LoadOptions {
  // Absolute path to a locally-downloaded, checksum-verified artifact. Required:
  // this function never reaches the network itself.
  path?: string;
  // Must be explicitly true. Guards the whole external path out of CI and out
  // of accidental default runs.
  allowExternal?: boolean;
}

// Placeholder loader. External datasets require a downloaded artifact, a
// verified checksum, and an LLM judge to score answers; wiring that is a
// deliberate, opt-in step outside the hermetic harness. This throws with clear
// guidance rather than pretending to load, so CI and default `pnpm eval` stay
// offline and deterministic.
export function loadExternalDataset(
  key: string,
  options: LoadOptions = {},
): EvalDataset {
  const spec = EXTERNAL_DATASETS[key];
  if (!spec) {
    const known = Object.keys(EXTERNAL_DATASETS).join(", ");
    throw new Error(`Unknown external dataset '${key}'. Known: ${known}.`);
  }
  if (!options.allowExternal) {
    throw new Error(
      `Refusing to load external dataset '${spec.name}' without allowExternal. ` +
        `These datasets need network download, a pinned checksum, and an LLM ` +
        `judge; they do not run in CI. Pass { path, allowExternal: true } once ` +
        `you have downloaded and verified the artifact from ${spec.url}.`,
    );
  }
  if (!spec.sha256) {
    throw new Error(
      `No pinned checksum recorded for '${spec.name}'. Record the SHA-256 of ` +
        `the downloaded artifact in EXTERNAL_DATASETS before loading it.`,
    );
  }
  if (!options.path) {
    throw new Error(
      `Provide { path } to a locally downloaded '${spec.name}' artifact; this ` +
        `loader never fetches over the network itself.`,
    );
  }
  // Parsing an external artifact into EvalCases (and running an LLM judge for
  // answer correctness) is intentionally left for the opt-in integration that
  // owns the model call. The hermetic harness uses syntheticDataset().
  throw new Error(
    `Parsing for '${spec.name}' is not wired into the hermetic harness. Use ` +
      `syntheticDataset() for offline runs, or implement artifact parsing plus ` +
      `an LLM judge behind this call for the full benchmark.`,
  );
}
