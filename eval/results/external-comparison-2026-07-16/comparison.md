# External Comparison: ReMem vs mem0 on mem0's LoCoMo harness (2026-07-16)

> **Corrected 2026-08-03.** The measured numbers below are unchanged and stand.
> The interpretation originally attached to them was wrong in two places: the
> belief layer was not present at the cutoffs this run reports, and the
> open-domain delta is a single question. See "Corrections" at the end before
> citing anything here. The original "Read" section is retained, struck through
> in prose, so the record shows what was claimed and what replaced it.

First head-to-head of ReMem against a real market system on that system's own
ground. Both columns run inside mem0's `mem0ai/memory-benchmarks` LoCoMo harness
(`oss` backend mode), so the answerer, judge, prompts, retrieval cutoffs, and
question set are identical for both. The only thing that differs is the memory
backend behind the `/memories` and `/search` REST contract.

This replaces the earlier apples-to-oranges number (ReMem 24.3% under our own
weak-answerer harness vs mem0's published ~66%), which was a harness artifact,
not a quality gap.

## Setup

- Harness: `mem0ai/memory-benchmarks`, `benchmarks/locomo/run.py`, `--backend oss`
- ReMem column: `src/eval/mem0-adapter-server.ts` (ReMemKernel behind the mem0
  OSS REST contract), transformers embedder + LLM consolidator (OpenRouter
  gpt-4o-mini), beliefs enabled
- mem0 column: mem0 OSS server, `text-embedding-3-small` + mem0 extraction
- Shared answerer: gpt-4o-mini
- Shared judge: gpt-4o-mini (LLM-judge accuracy)
- Scope: 3-conversation pilot, 385 questions, categories 1-4, top_k 50,
  cutoffs 10/20/50
- Metric: LLM-judge accuracy (percent judged correct)

## Overall (LLM-judge accuracy)

| Cutoff | ReMem | mem0  | Delta          |
|--------|--------|-------|----------------|
| top-10 | 66.2%  | 69.9% | mem0 +3.7      |
| top-20 | 74.3%  | 73.8% | ReMem +0.5    |
| top-50 | 77.1%  | 73.2% | ReMem +3.9    |

## By category (top-50)

| Category    | ReMem | mem0  | Delta       |
|-------------|--------|-------|-------------|
| single-hop  | 91.0%  | 89.0% | ReMem +2.0 |
| multi-hop   | 83.8%  | 90.5% | mem0 +6.7   |
| open-domain | 81.0%  | 85.7% | mem0 +4.7   |
| temporal    | 40.0%  | 21.1% | ReMem +18.9|

## Read (original, 2026-07-16, superseded)

The following was the reading at the time. Points 2 and 3 do not survive the
2026-08-03 audit; see Corrections.

- ReMem wins overall at top-50 (77.1 vs 73.2) and is level at top-20. mem0's
  tighter retrieval edges ahead at top-10.
- ~~ReMem's standout is temporal reasoning: 40.0% vs 21.1%, nearly 2x. The belief
  and consolidation layer pays off on time-ordered questions, the axis the paper
  argues for.~~ **The temporal result is real; the attribution to the belief
  layer is not. See C1.**
- ~~Not a clean sweep: mem0 is stronger on multi-hop synthesis and open-domain at
  top-50.~~ **Multi-hop stands. Open-domain is one question. See C2.**

## Corrections (2026-08-03)

### C1. The belief layer was not in the reported cutoffs

CONFIRMED against `src/eval/mem0-adapter-server.ts` at the commit this run used.

`REMEM_RANK` defaults to `observations-first` (`:43`). In that mode
`flattenPack` builds `[...observations, ...beliefs]` and breaks once it has
emitted `limit` results (`:135-136`, `:143-150`). Recall requests
`topKObservations = limit`. Offline replay of the same retrieval path over
LoCoMo conversations 0 and 1 measured 38.6 to 46.7 observations clearing the
`minScore` floor per query, against `limit = 50`.

Beliefs therefore occupied roughly slots 39 to 50 and did not reach the top-10
or top-20 columns at all. Those two columns compare **raw dialogue turns against
mem0's distilled facts**. They are not a test of the belief layer.

The same replay, run with the consolidator off so that zero beliefs existed,
still recovered 84% of temporal gold at top-10 and 98% at top-50. The temporal
advantage is therefore a property of retrieving verbatim dialogue text, not of
consolidation, decay, or confidence. The setup line "beliefs enabled" is
accurate as configuration and misleading as a description of what was measured.

**What the run does support:** ReMem's retrieval is competitive with mem0's on
this harness, and decisively better on temporal questions. It does not yet
support any claim about the belief layer's contribution. An ablation with
`REMEM_CONSOLIDATOR=null` against the same columns is required for that, and has
not been run.

### C2. The open-domain delta is one question

Open-domain is n=21. 81.0% is 17 correct, 85.7% is 18. ReMem's own open-domain
series across the three cutoffs is 17, 16, 17, which is non-monotone in k and
therefore inside the noise floor of this cell. This should not have been reported
as a directional finding, and no engineering effort should be spent on it until a
full-conversation run gives the cell adequate n.

Multi-hop (n larger, 6.7 points) remains a genuine deficit and is not affected by
this correction.

### C3. mem0's temporal score needs an explanation before it is cited

An audit of mem0's OSS server suggests its 21.1 on temporal reflects an absent
timestamp path rather than weak temporal reasoning: the harness sends a session
epoch that the server's request model appears not to accept, leaving memories
stamped at ingest time.

**Status: not independently re-verified.** It is recorded here so the claim is
not silently relied on. Do not cite it externally until confirmed against a named
mem0 commit, and note that mem0's OSS engine was substantially rewritten in
April 2026, so "mem0" without a commit hash is ambiguous in any comparison.

If it holds, it changes the meaning of the temporal column: the honest framing is
that mem0's reference server cannot ground time, not that ReMem out-reasons it.

### C4. Reporting requirements going forward

- Name the exact mem0 commit in every comparison. The OSS engine changed
  materially in April 2026.
- mem0's published 92.5 on LoCoMo uses a stronger answerer and judge and a much
  larger top-k than this run. The 73.2 here is not that number and should never
  be presented as a refutation of it.
- LoCoMo's judge and answer key have documented reliability problems. Treat
  LoCoMo as one row among several, not as a headline result.
- Add a tuned BM25 baseline and a full-context baseline before publishing.
  Multiple independent evaluations report memory systems failing to beat one or
  both.

## Caveats

- 3-conversation pilot (n=385). Small categories are noisy (open-domain n=21).
  A full 10-conversation run would firm up the smaller cells.
- Single benchmark (LoCoMo). LongMemEval and BEAM are available in the same
  harness and not yet run.
- The embedder differs across columns (MiniLM-L6, 384-dim local, vs
  `text-embedding-3-small`, 1536-dim hosted). This is a confound in every cell
  and is not controlled for in this run.

## Artifacts

- `reMem-metrics.json`, `mem0-metrics.json`: metadata + metrics_by_cutoff only
  (full per-question evaluations omitted for size).
- Raw run ids: reMem `3b38354d` (20260716_193708), mem0 (20260716_202705).
