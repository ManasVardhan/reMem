# ReMem: Data

Where the evaluation data lives, what each set is for, and how we load it. All
sets below are public; this repository redistributes none of them. You download
a set yourself into `data/raw/` (git-ignored) and point the loader at it.

## What ships

- **Loaders:** `src/eval/locomo.ts` and `src/eval/prefeval.ts` read a
  downloaded set from a path you pass with `--data` (defaults under
  `data/raw/`, e.g. `data/raw/locomo10.json`). `src/eval/datasets.ts` is a
  registry of the other sets with source URLs; it never downloads anything. For
  sets without a loader, the **Ingest** notes below describe the intended
  mapping, not shipped code.
- **Synthetic fixture:** `src/eval/fixtures.ts`, a small hand-authored labeled
  dataset covering extraction, knowledge updates, scope and abstention. It is
  what `pnpm eval` and the unit tests run, so they need no downloads and no
  network.
- **Recorded results:** per-run outputs under `eval/` (see `docs/FINDINGS.md`).

Not included: there is no download script, checksum manifest or
`data/synthetic/` directory. Fetch each set from the source listed below.

```
data/
  raw/            # downloaded by you, untouched (git-ignored)
    locomo10.json
    prefeval/
    ...
```

## Core evaluation sets

### LoCoMo

- **Use:** headline conversational-memory QA (single/multi-hop, temporal,
  adversarial).
- **Shape:** ~10 long multi-session dialogues; ~1.5K QA pairs total.
- **Source:** `snap-research/locomo` (GitHub) - dataset JSON is in-repo; also
  mirrored on Hugging Face. Paper: "Evaluating Very Long-Term Conversational
  Memory of LLM Agents" (2024).
- **Ingest:** each dialogue turn -> one `observation` (source=`slack`-like chat,
  actor=user/assistant, ts from session metadata). QA pairs -> eval harness.

### LongMemEval

- **Use:** the ability-isolating benchmark (extraction, multi-session, temporal,
  knowledge-update, abstention). Our primary thesis test.
- **Shape:** 500 questions; `longmemeval_s` (~115k-token histories) and
  `longmemeval_m` (~1.5M-token histories) variants; `_oracle` for
  retrieval-free upper bound.
- **Source:** `xiaowu0162/LongMemEval` (GitHub) + Hugging Face dataset. Paper:
  ICLR 2025.
- **Ingest:** provided session logs -> observations; keep the gold-evidence
  session ids so we can score retrieval recall@k / MRR, not just final answers.

### BEAM

- **Use:** deep, book-length memory (100K to 10M tokens, 10 abilities).
- **Shape:** long synthetic + curated histories with per-ability probes.
- **Source:** released 2025 (paper "BEAM: Benchmarking Long-context memory");
  data on Hugging Face / project page. Note the exact release tag you use,
  since it is new and may version.
- **Ingest:** stream in chunks; this set is used for the length-degradation
  curve, so we keep the native ordering and timestamps.

### PrefEval

- **Use:** preference-following over long conversations - our personalization +
  scope + supersession test.
- **Shape:** 3,000+ user-preference / query pairs across ~20 topics; explicit,
  implicit, and preference-conflict settings.
- **Source:** `amazon-science/PrefEval` (GitHub). Paper: ICLR 2025 (oral).
- **Ingest:** stated preference -> observation stream leading to a belief; the
  probe query -> eval; we assert the recalled context contains the active
  preference and that violations are counted per their error taxonomy.

### PersonaMem

- **Use:** tracking an evolving persona / up-to-date user model.
- **Shape:** multi-session persona dialogues with labeled preference changes.
- **Source:** released 2025; Hugging Face dataset (`bowen-upenn/PersonaMem` /
  project mirror). Pin the tag.
- **Ingest:** persona updates become CONTRADICT/REINFORCE sequences; we score
  whether recall uses the newest state.

### LaMP

- **Use:** downstream personalization utility (does recalled context improve
  generation/classification).
- **Shape:** 7 tasks with per-user profiles + time-based splits.
- **Source:** LaMP benchmark project (`LaMP-benchmark`, project site
  lamp-benchmark) + Hugging Face. Paper 2023, widely used.
- **Ingest:** user profile entries -> observations; run each task with vs
  without ReMem context to measure lift.

## Supporting / pretraining-style sets

### MSC (Multi-Session Chat)

- **Use:** additional multi-session dialogue for tuning consolidation windows
  and decay defaults before touching the scored benchmarks.
- **Source:** ParlAI `msc` task (Facebook/Meta). Paper: "Beyond Goldfish
  Memory" (2021).

## Licensing / handling

- Raw corpora stay git-ignored and are downloaded by hand from the sources above.
- We redistribute nothing; we only ship loaders, the synthetic fixture in
  `src/eval/fixtures.ts`, and our own recorded results.
- All sets are used under their research licenses; commercial use of any set is
  gated on its own terms and is out of scope for the kernel's test suite.
