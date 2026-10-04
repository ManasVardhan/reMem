# reMem provider for MemoryBench

[MemoryBench](https://github.com/supermemoryai/memorybench) is an MIT-licensed
harness from Supermemory that runs the same benchmark questions, pipeline, and
judges against every memory provider. It ships adapters for Supermemory, Mem0,
and Zep, plus two baselines that need no API key (`rag` and `filesystem`).

Running reMem there is what makes a comparison provable rather than
self-reported: the harness is a competitor's, the answerer and judge are shared
across providers, and the baselines are the ones the field says memory systems
often fail to beat.

The harness itself is not vendored into this repo. This directory holds only the
provider we wrote plus the registration patches, so reMem's history stays free of
someone else's codebase.

## Setup

```bash
git clone https://github.com/supermemoryai/memorybench
cd memorybench && bun install
bash ../eval/memorybench/apply.sh .
```

Then start reMem's adapter from the repo root and point the provider at it:

```bash
REMEM_EMBEDDER=transformers REMEM_CONSOLIDATOR=llm \
REMEM_RANK=observations-first REMEM_MIN_SCORE=0 REMEM_ALPHA=0.3 \
REMEM_WINDOW=1 REMEM_DEMOTE_SUPERSEDED=true PORT=8899 \
pnpm serve:mem0-adapter
```

## Files

| File | Purpose |
| --- | --- |
| `provider/index.ts` | The `Provider` implementation, copied to `src/providers/remem/index.ts` |
| `provider/index.test.ts` | Its tests, run by `bun test` |
| `provider/*.patch` | Registration edits for `src/types/provider.ts`, `src/providers/index.ts`, `src/utils/config.ts` |
| `apply.sh` | Copies the provider in and applies the patches |

## The property that must not regress

reMem's LoCoMo temporal accuracy moved from 34.4% to 95.6% for one reason: the
session date and the speaker label reached the answering model. Both had been
silently dropped at the adapter boundary. See `docs/FINDINGS.md`, entry F5.

The provider therefore has to carry both through:

- **Session date.** MemoryBench's LoCoMo loader puts it at `session.metadata.date`
  (ISO, via its `parseLocomoDate`). The provider converts it to Unix seconds and
  sends it as `timestamp` on `POST /memories`. `message.timestamp` is checked
  first for forward compatibility but is never populated by any benchmark
  currently in the harness. If neither is present the provider logs loudly rather
  than silently defaulting to the current time.
- **Speaker.** MemoryBench sets `message.speaker` from the raw LoCoMo name. The
  provider prefixes content with it, so reMem stores `"Caroline: I went to a
  support group yesterday."` rather than a bare sentence.

Verified end to end against a live adapter: `created_at` came back as
`2023-05-08T13:56:00.000Z` for a session dated 8 May 2023, and the memory text
retained its `Caroline:` prefix.

## Upstreaming

The provider is written to match the conventions of the adapters already in the
harness so it can be submitted to `supermemoryai/memorybench` directly. A merged
provider means a third party can score reMem without involving us, which is the
strongest form of the claim.
