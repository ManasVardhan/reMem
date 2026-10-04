# ReMem: evaluation findings

A running log of what the benchmarks actually tell us. Newest first. Each entry
records the run, the observation, the mechanism, and the follow-up it triggers.

## F13 - Supersession is worth 16 of the 30 points, and Zep beats us by 17 (2026-08-11)

Run: MemoryAgentBench, Conflict Resolution, `factconsolidation_sh_6k`, the same
100 questions as F10, answerer `gpt-4o-mini`, metric `substring_exact_match`.
Zep ran through the harness's own adapter at `retrieve_num` 10, matching ours.
The ablation is our own kernel with `REMEM_DEMOTE_SUPERSEDED=false` and nothing
else changed. Artifacts: `eval/memoryagentbench/zep-sh_6k.json`,
`eval/memoryagentbench/remem-nosupersede-sh_6k.json`.

| System                    | Correct    | Ingest  | Context/question |
| ------------------------- | ---------- | ------- | ---------------- |
| Zep, bi-temporal edges    | **62/100** | 578.7 s | 5,159 tok        |
| reMem, supersession on    | 45/100     | 166.0 s | 594 tok          |
| reMem, supersession off   | 29/100     | 118.4 s | 474 tok          |
| no-memory baseline (mem0) | 15/100     | 3.8 s   | 203 tok          |

Paired McNemar exact, n = 100: reMem-on vs reMem-off 24/8, **p = 0.007**.
reMem-off vs the no-memory baseline (mem0) 24/10, **p = 0.024**. Zep vs reMem-on
26/9, **p = 0.006**.

Observation, and it corrects F10: **the 30 point gap over the no-memory
baseline (mem0, which stored nothing; see the F10 correction) is about half
supersession.** 15 to 29 is the ledger and its retrieval, which survives with
supersession switched off. 29 to 45 is the supersession mechanism, measured
within one system with everything else held constant. F10 read the whole gap as
evidence about the belief layer; that was too generous by roughly half.

Second observation: **Zep outperforms reMem by 17 points, significantly.** reMem
is not the strongest supersession system available. It spends 8.7x less context
and ingests 3.5x faster, so the honest position is efficiency rather than
accuracy. The cheap first follow-up test: match context volume before assuming
the gap is architectural.

Interpretation: **the evidence supports supersession as a mechanism-class
effect, not a single-implementation one.** Two independently built mechanisms
both separate sharply from the no-memory baseline, so density-dependent
detectability is a property of the mechanism class rather than of one
implementation. That retires the one-mechanism limitation. For the product it is
a real setback and should not be softened.

Caveats: one dense benchmark, synthetic, one context, 100 questions, single
runs. Zep's ingest is asynchronous and its cost is only honest because we
measured wall-clock until every episode reported processed.

## F12 - The benchmark's own Zep adapter does not run as shipped (2026-08-11)

Adding Zep to F13 required fixing seven defects in an adapter distributed with
MemoryAgentBench, none of them ours:

1. `service_name: azure_openai` in the config, which no branch in `methods/zep.py` reads.
2. `agent.py` hardcodes `source="azure"`, ignoring the config entirely.
3. `methods/zep.py` uses `X | None` syntax that the harness's working interpreter, Python 3.9, cannot parse.
4. `zep_cloud` appears nowhere in `requirements.txt`.
5. User, thread, and graph identifiers are built from `context_id`, which is `None` during memorisation and `0` at query time, so the harness writes to one graph and reads from another.
6. Resource creation is not idempotent, so any rerun dies on "user already exists".
7. Queries are issued 0.8 seconds after `graph.add`, which is asynchronous and takes roughly ten minutes to settle.

Observation: six of these crash. **The seventh returns a plausible number.** With
it uncorrected the harness reports Zep at 0/3 with a 0.8 second ingest, because
retrieval returns nothing and the answerer falls back on parametric knowledge:
it answered "Basketball", "Rurouni Kenshin" and "England" where the
counterfactual golds were "pesäpallo", "The Fairly OddParents" and "India".
Corrected, the same setup gives 62/100 and 578.7 seconds.

Decision: this is the strongest evidence in the paper for the protocol's
integration-validation step, and it is better than our own two defects because
it is in someone else's peer-reviewed artifact and it fails quietly. Anyone who
has published a Zep column from this harness either fixed all seven silently or
did not run it.

## F11 - Contradiction density: 0.0 and 0.0-0.3 percent against 81 percent (2026-08-11)

Run: a classifier over LoCoMo and PrefEval, `openai/gpt-5-mini` via OpenRouter,
300 stride-sampled questions each; and an exact derivation, no model, over
`factconsolidation_sh_6k`. Artifacts under `eval/density/results/`, audit in
`eval/density/labels/precision-audit.jsonl`.

| Benchmark                 | n   | Density         | 95% CI       | Failures |
| ------------------------- | --- | --------------- | ------------ | -------- |
| PrefEval, all three forms | 300 | **0.0%**        | [0.0, 1.3]   | 0        |
| LoCoMo, raw               | 300 | 1.7%            | [0.7, 3.8]   | 0        |
| LoCoMo, audited           | 300 | **0.0 to 0.3%** | [0.0, 1.9]   | 0        |
| factconsolidation sh 6k   | 100 | **81.0%**       | [72.0, 87.0] | derived  |

Validation: against the derived benchmark the classifier reaches recall 0.914,
precision 1.000, and agreement 0.929 over the 99 scoreable questions. An
earlier value of 0.930 counted the single unscoreable question as a true
negative, which the derived method cannot support. On conversational text precision is 0 to 20 percent, from a
hand audit of all five LoCoMo flags, of which four were clearly spurious and one
ambiguous. Raw conversational densities are therefore upper bounds, and the
error runs against the thesis.

Observation: **this explains F4, F6, F7 and F9.** Those benchmarks contain almost
no questions a supersession mechanism could act on, so four null results were
findings about the instruments rather than about the belief layer.

Two instrument choices are disclosed rather than buried. The prompt was revised
once, after a ten-question sample showed it flagging 7 false positives by asking
whether the context contained a contradiction instead of whether answering
required resolving one. And the classifier model was chosen by agreement with
hand-read verdicts, not by price.

Caveats: three benchmarks is three points and we fit nothing through them. A
misconfigured run during this work failed all 300 calls and reported a density
of 0.0 percent, the exact number the thesis predicts; the failure counter is
what caught it, and no run with a non-zero failure count is reportable.

## F10 - On conflict resolution the belief layer works: reMem 45% vs mem0 15%, p = 1.4e-06 (2026-08-10) (corrected 2026-10-03: mem0 was a no-memory baseline here)

Run: **MemoryAgentBench** (`HUST-AI-HYZ/MemoryAgentBench`, MIT, ICLR 2026),
Conflict Resolution competency, `factconsolidation_sh_6k`. The harness was
unmodified for these two systems. Its Zep branch was later patched to make F12
and F13 possible; those patches do not touch the reMem or mem0 paths, so these
numbers stand as measured.
One shared context ingested once, then 100 questions. Answerer `gpt-4o-mini`,
metric `substring_exact_match`, the harness's own. reMem ran with the belief
layer ON: `consolidator=llm`, `rankMode=beliefs-first`, `demoteSuperseded=true`.
mem0 ran through MemoryAgentBench's own adapter, which we did not write.
Artifacts under `~/MemoryAgentBench/outputs/`, with the per-cell result JSONs
committed at `eval/memoryagentbench/`. The checkout was moved out of `/tmp` on
2026-08-10 so the raw outputs survive a reboot.

Extended to a 2x2 over hop count and context size, both systems on the
identical questions in each cell:

| Variant        | reMem     | no-memory baseline (mem0) | Delta     | McNemar p   | reMem ingest |
| -------------- | --------- | ------------------------- | --------- | ----------- | ------------ |
| single-hop 6k  | 45.0%     | 15.0%                     | **+30.0** | **1.4e-06** | 165 s        |
| single-hop 32k | **57.0%** | 23.0%                     | **+34.0** | **1.9e-08** | 494 s        |
| multi-hop 6k   | 4.0%      | 2.0%                      | +2.0      | 0.69        | 141 s        |
| multi-hop 32k  | 5.0%      | 3.0%                      | +2.0      | 0.73        | 548 s        |

On single-hop 6k, paired n = 100: both correct 10, only reMem 35, only mem0 5,
neither 50. Context tokens 594 against mem0's 203, ingest 165 s against 3 s.

Two things the 2x2 establishes that the single cell did not.

**The lead holds at scale and grows** [corrected: the lead is over a no-memory
baseline; see the correction below]. The prediction before running 32k was that
a larger belief store would worsen the discrimination problem visible in the 6k
failures, where hundreds of near-identical `predicate: value` tuples sit at a
uniform 0.85 confidence. The opposite happened: reMem went 45.0 to 57.0 and the
gap widened from +30 to +34. More context supplied more supersession chains to
resolve, and the flattening did not bite at this size. The prediction was wrong
in reMem's favour, which is worth stating plainly.

**Multi-hop collapses for both systems.** 4 to 5 percent for reMem, 2 to 3 for
mem0, not significant at either size. Chaining through two superseded facts is
unsolved by either architecture. Any claim about "conflict resolution" must say
single-hop, or it overstates by an order of magnitude.

Observation: **this is the first non-null measurement of reMem's belief layer
against an external competitor** [corrected: over a no-memory baseline; see the
correction below]. F4, F6, F7, and F9 all measured null or negligible on LoCoMo
and PrefEval. The hypothesis that prompted moving to this benchmark was that
those benchmarks average consolidation quality away, because most of their
questions do not involve a contradiction, so a system that resolves
contradictions has nothing to demonstrate. Conflict Resolution isolates exactly
that ability, and the belief layer shows a 30 point lead [see F13: supersession
accounts for 16 of those points, and Zep beats reMem by 17].

Two genuine defects were found and fixed getting here, both of the same class as
F5 and both benchmark-independent:

1. **Beliefs carried no timestamp.** `flattenPack` set `created_at: null` for
   every belief, an explicit earlier decision reasoned as "beliefs are not dated
   events". For a layer whose premise is that beliefs change over time, emitting
   beliefs that no consumer can order is a defect. Fixed by exposing
   `lastReinforcedTs`, the moment the belief was last supported by evidence.
   Commit `6397909`. The implementer also caught that `flattenPack` was using
   `created_at !== null` to distinguish beliefs from observations, so the fix
   would have silently changed dedup behaviour; the discriminator moved to
   `confidence === null`.
2. **Ingest swallowed whole chunks.** The harness adapter sent a 4,096-character
   chunk as one message, so reMem stored it as ONE observation with ONE
   timestamp. Hundreds of facts collapsed onto a single point in time and a
   single averaged embedding, destroying both ordering and retrievability. This
   is Task 7's defect one level up: reMem's own LoCoMo loader already spaces
   events (`src/eval/locomo.ts`), the adapter did not. Fixed by splitting on the
   natural event boundary, one observation per line with incrementing
   timestamps. Measured effect on a 3 question smoke: 0/3 to 1/3, and 45/100 at
   full scale.

Mechanism: `factconsolidation` presents many facts, some superseding others, with
an explicit serial number marking recency, and asks which assertion is current.
reMem's supersession machinery (CONTRADICT ops, `superseded` status, and the
demotion of superseded evidence added in Task 9) is built for exactly this
shape.

Correction (2026-10-03): an earlier version of this entry said mem0's ADD-only
extraction stores both the stale and the current fact. That described mem0 v3
(the teardown's subject), not what ran. MemoryAgentBench's adapter imports the
mem0 copy bundled in the harness repo (added 2025-07-06, still the version at
commit 455306d) and calls `add` with default `infer=True`, which runs the old
ADD/UPDATE/DELETE/NONE decision call and applies the result
(`mem0/memory/main.py:286-302` in that copy). So mem0 here was update-capable,
not append-only. Raised by workshop reviewers.

Replay (2026-10-03, `eval/memoryagentbench/mem0_replay.py`, output
`mem0-replay-sh_6k-2026-10-03.json`): feeding the same sh_6k context through the
bundled mem0 exactly as the adapter does, its fact-extraction call returned
`{"facts": []}` for both chunks, so **mem0 stored zero memories** and no
ADD/UPDATE/DELETE ever fired. The extraction prompt targets personal facts about
the user and discards encyclopedic ones. The original run agrees: mem0's
per-question `input_len` is 199 to 210 tokens single-hop (to 224 multi-hop), which is the
answer prompt alone with an empty memory block (203 tokens computed), and ingest
took 3 s for two chunks. **mem0's 15/100 (23/100 at 32k) is therefore a
no-memory score from the answerer's parametric knowledge**, not a measurement of
mem0's memory. The 30 point gap is reMem over a no-memory floor; the 16 point
on/off ablation and the Zep comparison are unaffected.

Cost, which must be reported alongside the win: reMem spent **165 seconds** on
ingest against mem0's **3 seconds**, roughly 55x, because it runs an LLM
consolidation pass per observation while mem0's harness path does almost no work
at write time. reMem also used 594 context tokens against 203. The belief layer
is not free and the comparison should never omit that.

Decision: **the belief layer has a demonstrated domain, and it is single-hop
contradiction resolution, not episodic recall, not preference following, and not
multi-hop conflicts.** State the claim that narrowly. The defensible sentence
is: on single-hop conflict resolution in MemoryAgentBench, reMem resolves
superseded facts substantially better than mem0, 45 vs 15 at 6k and 57 vs 23 at
32k [corrected: over a no-memory baseline; see the correction above], both
significant on paired tests, at roughly 55x to 165x mem0's ingest cost. The
advantage does not extend to multi-hop conflicts, where both score under 6. Do
not generalise it to LoCoMo or PrefEval, where four measurements say the
opposite.

This also revises F9's framing. The conclusion there was that the belief layer
had not demonstrated value against external competitors across two benchmarks.
That remains true of those two benchmarks. The correct reading now is that
**LoCoMo and PrefEval were the wrong instruments**, not that the layer is
without value.

Caveats: one dataset variant, one context, 100 questions from a single sample.
Single run, no variance estimate. Only mem0 was run as a comparator;
MemoryAgentBench also ships Zep, Cognee, Letta, and HippoRAG configs and those
would strengthen or complicate the picture. `factconsolidation` is synthetic: a
dense list of unrelated world facts with explicit serial numbers, not
conversation, so it isolates the ability cleanly but is not a realistic
workload. reMem still fails 55% of these questions, and the failures show
consolidation flattening many similar facts into near-identical
`predicate: value` tuples at uniform 0.85 confidence that retrieval cannot
discriminate between.

Follow-up (F11): the `_mh` variant and the 32k size are now run and included
above. What remains is the remaining MemoryAgentBench comparators on this
split. If the lead holds against Zep, which has genuine bi-temporal edge
invalidation and is the closest architectural peer, that is the strongest claim
available [answered in F13: it does not, Zep leads by 17 points]. Also worth
measuring: how much of the 45% survives at the 64k and 262k context variants,
where the belief store grows and the uniform-confidence discrimination problem
should worsen.

## F9 - On PrefEval against external competitors the belief layer shows no advantage: all four systems are statistically indistinguishable (2026-08-09)

Run: MemoryBench (`supermemoryai/memorybench`, MIT, **unmodified**), PrefEval
ported as a MemoryBench benchmark, 75 instances stratified 25 per form with a
seeded sample, the identical question set passed explicitly to every provider.
Answerer `gpt-5-mini`, judge `gpt-4o`, routed to MemoryBench's
`PREFERENCE_JUDGE_PROMPT` which grades the ground truth as a rubric rather than
an exact answer. reMem ran in the configuration F3 identified as correct for
this benchmark: **consolidator on, beliefs-first ranking, supersession enabled.**
Consolidation cost $0.07. Artifacts under `memorybench/data/runs/pref75-*/`.

Note (2026-10-03): mem0 returned **no memories for 48 of the 75 questions**, all
48 judged incorrect; on the 27 with retrieval it scored 22/27. Indexing reported
0 failures and search has no score threshold, so those users had zero stored
memories. Likely interaction with this harness's one-add-per-session ingestion
(preference turns plus 20 distractor turns, v2 async). Cause unconfirmed. mem0's
29.3% is therefore mostly a coverage failure; the rag and filesystem nulls stand.

This was the benchmark the belief layer was expected to win. F3 through F3-c
measured beliefs-first at **+20 to +27 percentage points** over reMem's own
naive-vector baseline on preference following, against +2.3 on LoCoMo (F4).

| Provider   | Overall | explicit | choice-based | persona-driven | Context tokens |
| ---------- | ------- | -------- | ------------ | -------------- | -------------- |
| rag        | 34.7%   | 28%      | **48%**      | 28%            | 217            |
| reMem      | 33.3%   | **44%**  | 36%          | 20%            | 1,361          |
| filesystem | 32.0%   | 32%      | 44%          | 20%            | 205            |
| mem0       | 29.3%   | 28%      | 28%          | **32%**        | 176            |

Paired McNemar exact tests, n = 75:

| Comparison          | Only first | Only second | p     |
| ------------------- | ---------- | ----------- | ----- |
| reMem vs mem0       | 22         | 19          | 0.755 |
| reMem vs rag        | 12         | 13          | 1.000 |
| reMem vs filesystem | 12         | 11          | 1.000 |

Observation: **every comparison is null.** Roughly equal numbers of questions
flip each way in all three. reMem sits mid-pack, 1.4 points behind a plain
chunked-RAG baseline and 4 points ahead of mem0, and none of it is distinguishable
from noise. reMem also uses 6 to 8 times more context (1,361 tokens against
roughly 200) for no accuracy gain.

Mechanism, as far as this run supports one: the only directional signal is that
reMem leads `explicit` (44% against 28 to 32%), the form where the preference is
stated outright and consolidation has a concrete target to distil. It trails on
`choice-based` and `persona-driven`, where the preference is implied or diffuse.
That is consistent with F3-c, which found the belief advantage concentrated where
distillation has something specific to work on and absent where the signal is
spread across redundant turns. At n = 25 per cell none of this is significant and
it should be treated as a hypothesis, not a result.

Decision: **F3's +20 to +27 point advantage did not survive a change of
baseline.** It was measured against reMem's own naive-vector implementation, in
reMem's harness, with reMem's judge. Against MemoryBench's `rag` and `filesystem`
baselines, judged by a preference-rubric judge we did not write, the advantage is
gone. Do not cite F3's margin as evidence of the belief layer's value against
external systems. It is evidence about one internal baseline.

This is the fourth measurement pointing the same way. F4: the belief layer is
worth +2.3 once on LoCoMo. F6 and F7: reMem's retrieval unit was mismatched and
fixing it closed a third of the gap to chunked RAG, no more. F9: on the benchmark
built for preference memory, no advantage over three other systems including two
baselines. **Across two benchmarks and four measurements, reMem's belief layer
has not demonstrated value against external competitors.** The one clear
competitive result on record (F8, reMem beating mem0 by 20 points, p = 0.031) was
produced with the belief layer switched OFF.

A further caution: all four systems score near 30% here. PrefEval is hard for
everything in this configuration, which limits how much any comparison on it
discriminates. A benchmark where nobody does well is weak evidence in either
direction.

Caveats: n = 75 with 25 per form, so per-form numbers are directional only and
only the overall comparison carries the p-values. Single seed, single run, no
variance estimate. Judge and answerer are both OpenAI models, so not
cross-vendor. Supermemory was excluded (account out of credits). mem0 ran through
MemoryBench's own adapter, which we did not write or audit. PrefEval ships no
dates and no named speakers, so the temporal and speaker plumbing that F5
measured at +13 points on LoCoMo is inactive here and cannot contribute.

Follow-up (F10): the honest question is now whether the belief layer earns its
complexity at all, and the honest answer from four measurements is that it has
not been shown to. Before more benchmarking, the abilities it was actually
designed for and which none of these benchmarks isolate are contradiction
resolution, calibrated confidence, and abstention grounded in that confidence.
The literature sweep found that no memory paper has ever reported calibration
(ECE, selective risk), which remains the one genuinely unclaimed contribution.
That is a different kind of result from a benchmark win and should be pursued as
such, or the belief layer should be scoped down and the retrieval path, which
demonstrably does work, made the product.

## F8 - reMem beats mem0 by 20 points on MemoryBench, and mem0's extraction writes wrong dates into memory text (2026-08-09)

Run: MemoryBench (`supermemoryai/memorybench`, MIT, **unmodified**), LoCoMo,
50 questions stratified 10 per category with a seeded sample, the identical
question set passed explicitly to both providers. Answerer `gpt-5-mini`, judge
`gpt-4o`. reMem retrieval-only with `REMEM_SLOT_CHARS=800` and the rendered
context formatter; mem0 through MemoryBench's own adapter against their hosted
API. Artifacts under `memorybench/data/runs/sw800p-remem/` and `mb50b-mem0/`.

|                         | reMem             | mem0          |
| ----------------------- | ----------------- | ------------- |
| Accuracy                | **54.0%** (27/50) | 34.0% (17/50) |
| Context tokens          | 1,760             | **549**       |
| Search latency (median) | **27 ms**         | 492 ms        |

| Category        | reMem | mem0   | Delta |
| --------------- | ----- | ------ | ----- |
| multi-hop       | 60%   | **0%** | +60   |
| adversarial     | 90%   | 60%    | +30   |
| temporal        | 60%   | 50%    | +10   |
| world-knowledge | 50%   | 50%    | 0     |
| single-hop      | 10%   | 10%    | 0     |

Paired McNemar, n = 50: both correct 13, only reMem 14, only mem0 4, neither 19,
exact two-sided **p = 0.031, significant**.

Observation: reMem leads by 20 points and the difference is significant on a
paired test in a third-party harness. mem0's one clear advantage is context
efficiency, 549 tokens against 1,760, and that should be reported rather than
omitted. reMem's search is 18x faster, which is a local-versus-network
comparison and not a quality claim.

**mem0 scored 0 of 10 on multi-hop.** Inspecting the failures found a defect
worth recording precisely, because it is reproducible from the run artifacts.

For "When did Caroline go to the LGBTQ support group?" (gold: 7 May 2023) mem0's
top result was:

```
memory:     "Caroline attended an LGBTQ support group on August 7, 2026,
             describing the experience as powerful..."
metadata:   {"date": "2023-05-08T13:56:00.000Z", ...}
created_at: 2026-08-08T23:14:08+00:00
```

The correct session date **was delivered and stored**. MemoryBench passed
`2023-05-08` and mem0 kept it in metadata. But mem0's extraction, turning "I
went to a support group yesterday" into a standalone fact, resolved "yesterday"
against the **wall clock at ingest time** rather than the session date it held.
The memory text therefore asserts an event in 2026 that happened in 2023. A
second result shows the same pattern: "joined a new LGBTQ activist group on
Tuesday, August 3, 20.." against a session date of 2023-07-20.

This is worse than lacking a date. The metadata is right, so the system had the
information; the extractor overwrote it with a confidently stated wrong one, and
the answering model reads the text. Every multi-hop failure sampled was a
"when did X happen" question, which is why the category collapsed to zero.

Note this is a **different mechanism** from the one recorded against mem0's OSS
server, where `AddRequest` has no timestamp field and the value is dropped
entirely (see `eval/results/external-comparison-2026-07-16/comparison.md`, C3).
That is the self-hosted product; this is the hosted one. Two systems, two
mechanisms, the same outcome: time does not survive into what the model reads.

It is also a sharper version of F5 on our own system. reMem's dates existed and
were dropped at the adapter boundary; mem0's dates exist and are overwritten by
the extractor. In both cases the information was present and the answerer never
saw the truth. The general lesson is that a memory system's temporal correctness
depends on every hop preserving event time, and the failure is silent at each
one.

Decision: report the 20-point lead with its caveats. Do not present it as
architectural superiority: reMem ran **without its belief layer**, so this
compares reMem's retrieval against mem0's extraction. The multi-hop result is a
finding about mem0's extraction, not about reMem's design.

Caveats: n = 50 with 10 per category, so category cells are directional and only
the overall result carries the p-value. Single seed, single run, no variance
estimate. Judge and answerer are both OpenAI models, so not cross-vendor.
Supermemory was excluded because its account ran out of credits mid-run, a fact
about the account rather than the system. mem0 ran through MemoryBench's adapter,
which we did not write or audit. **Both systems lose to MemoryBench's plain `rag`
baseline at 68.0%** (F7), which is the result that should lead any honest summary.

Method note: `hitAtK` moved 74 to 62 percent between two runs whose retrieval was
byte-identical and differed only in prompt formatting, while accuracy was
unchanged. That suggests the harness computes retrieval hits against the
serialised context, so `hitAtK` is not comparable across providers using
different prompt formatters. Retrieval metrics quoted in F6 and F7 should be read
with that caveat until confirmed.

## F7 - Neighbour expansion is worth 10 points and closes a third of the gap to chunked RAG, no more (2026-08-09)

Run: MemoryBench (unmodified), LoCoMo, the same seeded stratified 50 questions
as F6, identical set passed explicitly to every configuration. Answerer
`gpt-5-mini`, judge `gpt-4o`, reMem retrieval-only. Only `REMEM_SLOT_CHARS`
varies. Artifacts under `memorybench/data/runs/sw*-remem/`, configs in
`eval/memorybench/config-sweep-*.json`.

F6 diagnosed reMem delivering 2.3x less context than chunked RAG at the same
slot budget. This implements the fix: each retrieved observation is expanded
with its ledger neighbours up to a character budget, so a slot carries a passage
rather than a sentence. Budget is a caller-supplied parameter, deliberately not
tuned to any competitor's chunk size, and defaults to off.

| Budget  | Accuracy  | Hit@10  | Context tokens | Chars per slot | Slots |
| ------- | --------- | ------- | -------------- | -------------- | ----- |
| 0 (off) | 46.0%     | 48%     | 1,212          | 119            | 10.0  |
| 400     | 50.0%     | 52%     | 1,719          | 342            | 10.0  |
| 800     | 54.0%     | **74%** | 2,602          | 740            | 10.0  |
| 1600    | **56.0%** | 70%     | 4,355          | 1,533          | 10.0  |

Per category (n = 10 each, directional only):

| Budget | single-hop | multi-hop | temporal | world-knowledge | adversarial |
| ------ | ---------- | --------- | -------- | --------------- | ----------- |
| 0      | 0          | 60        | 40       | 50              | 80          |
| 400    | 10         | 60        | 50       | 50              | 80          |
| 800    | 10         | 60        | 50       | 60              | **90**      |
| 1600   | **30**     | 60        | 60       | 70              | 60          |

Against the same 50 questions: rag 68.0% at 2,735 context tokens, filesystem
54.0% at 2,683, mem0 34.0% at 549.

Observation: expansion is worth **+10 points** (46.0 to 56.0), monotone across
every budget, so the effect is real rather than noise. Slot count holds at 10.0
throughout, confirming the id-keyed dedup fix; an earlier attempt collapsed ten
slots to six because `flattenPack` deduplicated observations by rendered text
and overlapping expansions rendered identically.

Hit@10 peaks at budget 800 (74%) and falls at 1600 (70%). Retrieval quality is
best at the middle budget; the further accuracy gain at 1600 comes from the
answerer having more material, not from better retrieval. Treat 800 as the knee.

Adversarial accuracy falls at 1600 (90 to 60). More context makes the system
likelier to answer when it should abstain. That is a direct, measured tension
between context volume and abstention, and it matters because abstention is one
of the abilities reMem's design claims.

**At a comparable context budget reMem now ties `filesystem` (54.0% at 2,602
tokens vs 54.0% at 2,683) and still trails `rag` by 14 points.** The gap was 22.
A third of it closed.

Decision: keep neighbour expansion, default it off, and treat 800 as the
recommended starting budget. Do not report it as making reMem competitive with
chunked RAG on this benchmark, because it does not.

The uncomfortable implication is worth stating plainly. The fix that helped was
"make retrieval units larger and more passage-like", which is what chunking
already does. Combined with F4 (the belief layer is worth 2.3 points here) and
F6 (the retrieval unit was mismatched), three consecutive measurements point the
same way: **on LoCoMo-style episodic QA, reMem's architecture is not where its
value lies, and a well-tuned chunked retriever is a strong baseline that reMem
does not beat.** That is consistent with the field-wide result that memory
systems often fail to beat plain RAG, and reMem is not an exception on this
axis.

Caveats: n = 50 with 10 per category, so category numbers are directional only.
Single seed, single run, no variance estimate. reMem ran without its belief
layer. Judge and answerer are both OpenAI models, so not cross-vendor.

Follow-up (F8): the axes reMem was designed for remain unmeasured against these
competitors. Preference following (PrefEval, where the belief layer is worth +20
to +27 per F3), contradiction resolution, and abstention with calibrated
confidence are where the architecture should show an effect if it has one.
LoCoMo has now been measured three ways and the answer has been consistent each
time. Continuing to optimise it is unlikely to change the conclusion.

## F6 - reMem's retrieval unit is too small: at a fixed slot budget it delivers 2.3x less context than chunked RAG, and loses to it (2026-08-09)

Run: MemoryBench (`supermemoryai/memorybench`, MIT, unmodified), LoCoMo, 50
questions stratified 10 per category with a seeded sample, identical question
set passed explicitly to every provider. Answerer `gpt-5-mini`, judge `gpt-4o`.
reMem ran retrieval-only (`REMEM_CONSOLIDATOR=null`), for reasons recorded in
`eval/memorybench/RUN-2026-08-08.md`. Artifacts under `memorybench/data/runs/`.

First measurement of reMem in a harness we did not write, against the baselines
the field says memory systems fail to beat.

| Provider              | Accuracy  | Hit@10 | MRR   | Context tokens | Chars per slot |
| --------------------- | --------- | ------ | ----- | -------------- | -------------- |
| rag (baseline)        | **68.0%** | 72%    | 0.563 | 2,735          | ~1,600 chunk   |
| filesystem (baseline) | 54.0%     | 70%    | 0.436 | 2,683          | large          |
| reMem                 | 46.0%     | 50%    | 0.313 | 1,151          | 170            |
| mem0                  | 34.0%     | 34%    | 0.206 | 549            | 164            |

Per category (n = 10 each, directional only):

| Category        | rag | filesystem | reMem | mem0 |
| --------------- | --- | ---------- | ----- | ---- |
| adversarial     | 90  | 90         | 80    | 60   |
| world-knowledge | 80  | 70         | 50    | 50   |
| multi-hop       | 70  | 50         | 60    | 0    |
| temporal        | 50  | 30         | 30    | 50   |
| single-hop      | 50  | 30         | 10    | 10   |

Observation: **both memory systems lose to plain chunked RAG.** rag beats reMem
by 22 points and mem0 by 34. reMem beats mem0 by 12 points, which is the
head-to-head we wanted, but third of four is the headline. Single-hop at 10
percent against rag's 50 is the outlier that prompted the diagnosis below.

Mechanism: `limit: 10` means different things to different providers.
MemoryBench requests ten results (`src/orchestrator/phases/search.ts:60`). rag
returns ten chunks of about 1,600 characters. reMem returns ten dialogue turns
of about 119 to 170 characters. Same slot budget, **2.3x less context reaching
the answerer** (1,151 tokens vs 2,735).

A traced failure makes it concrete. For "What musical artists has Melanie
seen?" (gold: Summer Sounds, Matt Patterson) reMem returned ten short reactive
turns, none containing a fact:

```
0.643  Melanie: Cool! What type of music do you play?
0.489  Melanie: Music's amazing, isn't it? Any songs that have deep meaning for you?
0.477  Melanie: Wow, that rocks! What's the main idea of your art?
```

`hitAtK` 0, and the answerer replied "I don't know". Short generic reactions
embed extremely well against short generic queries while carrying no
information. Chunked retrieval sweeps up the factual turns as neighbours whether
or not they rank; turn-level retrieval must rank each fact on its own merits and
loses to conversational filler.

This is the granularity corollary to "Fidelity Before Structure"
(arXiv 2601.00821). That paper measured that verbatim beats LLM-extracted
artifacts by 15.9 points on LoCoMo. What it does not say, and what this measures,
is that verbatim at **turn** granularity is too fine. mem0 is worse still (549
context tokens, 34 percent), so extraction hurts more than fine granularity, and
both lose to chunking.

Ruled out by direct test: **windowing is not the cause.** Re-running with
`REMEM_WINDOW=0` fixed the slot deficit (8.6 results per query became 10.0,
matching every other provider) and accuracy went 46.0 to 44.0 with Hit@10
unchanged at 50 percent and single-hop 10 to 0. The initial hypothesis, that
windowing was starving the result set, was wrong.

Why windowing did not help: it merges neighbours that are already inside the ten
retrieved slots rather than pulling unretrieved neighbours in from the ledger,
so at a small limit it consumes slots without adding much text. The instinct was
right and the implementation solves the wrong half of the problem.

Decision: the fix is to expand each retrieved observation with its session
neighbours **read from the ledger**, whether or not those neighbours were
retrieved, so a slot carries a passage rather than a sentence. That is a change
to the recall path, not a configuration flag. Target roughly rag's 1,600
characters per slot.

Do not report the 46.0 percent as reMem's standing without this context. It is a
correctly configured run of a system whose retrieval unit is mismatched to the
benchmark's slot budget.

Caveats: n = 50, 10 per category, so category cells are directional only. Single
seed, single run, no variance estimate. reMem ran without its belief layer.
Judge and answerer are both OpenAI models, so not cross-vendor. Supermemory was
excluded because its account ran out of credits mid-run, which is a fact about
the account and not about the system. mem0 and Supermemory were driven through
MemoryBench's existing adapters, which we did not write or audit.

Follow-up (F7): implement ledger-backed neighbour expansion in `recall()`, then
re-run this exact comparison. The seeded question set makes it a clean paired
before and after.

## F5 - Dated, ordered memories are worth 13 to 14 points; the belief layer is worth 2 (2026-08-08)

Run: same harness, models, and question set as F4 (mem0's LoCoMo harness, `oss`
backend, 3 conversations, n = 385, cutoffs 10 and 50, answerer
`openai/gpt-5-mini`, judge `anthropic/claude-sonnet-5`, consolidator
`gpt-4o-mini`, alpha 0.3, minScore 0). Column D adds three changes to column B's
configuration and changes nothing else. Artifacts:
`eval/results/ablation-2026-08-06/`, config captured in `config-D.json`.

The three changes, all of which fixed defects rather than adding capability:

1. **`created_at` returned on observation search results.** The harness sorts
   memories chronologically by `created_at` and renders each as `(date) memory`
   (`benchmarks/locomo/prompts.py:172-181`). reMem never returned the field, so
   every memory reached the answerer as `(unknown date)` and the harness's
   chronological sort had an empty key for all 50 results. Columns A, B, and C
   all ran under that handicap.
2. **Distinct per-turn timestamps.** Through the adapter every turn in a session
   was stored with the identical `ts` and a `randomUUID()` id, and
   `readObservations` sorts `ORDER BY ts ASC, id ASC`, so same-session turns had
   no meaningful order at all. reMem's internal loader already spaced turns
   (`src/eval/locomo.ts:129-136`); the adapter never adopted it.
3. **Windowed rendering and supersession demotion.** One turn per slot became a
   turn plus its same-session neighbours (138 to 336 characters mean slot), and
   observations whose only supporting belief is superseded are demoted rather
   than removed.

Accuracy (LLM-judge, n = 385):

| Cutoff | A no beliefs | B beliefs in tail | C beliefs on merit | D plus the three fixes |
| ------ | ------------ | ----------------- | ------------------ | ---------------------- |
| top-10 | 66.8%        | 68.1%             | 67.0%              | **82.1%**              |
| top-50 | 75.6%        | 77.9%             | 76.9%              | **90.9%**              |

By category:

| Category    | n   | B top-10 | D top-10 | B top-50 | D top-50 |
| ----------- | --- | -------- | -------- | -------- | -------- |
| single-hop  | 200 | 83.5     | 83.5     | 92.5     | 90.5     |
| multi-hop   | 74  | 67.6     | 71.6     | 87.8     | 87.8     |
| open-domain | 21  | 90.5     | 90.5     | 90.5     | 85.7     |
| temporal    | 90  | 28.9     | **85.6** | 34.4     | **95.6** |

Paired McNemar exact tests:

| Comparison               | top-10                 | top-50                 |
| ------------------------ | ---------------------- | ---------------------- |
| A to B, beliefs added    | +1.3, p = 0.227        | +2.3, p = 0.035        |
| B to C, beliefs promoted | -1.0, p = 0.503        | -1.0, p = 0.481        |
| B to D, the three fixes  | **+14.0, p = 5.5e-08** | **+13.0, p = 5.3e-08** |

Observation: the gain is almost entirely temporal. Temporal moves 28.9 to 85.6
at top-10 and 34.4 to 95.6 at top-50. Every other category is flat within noise:
multi-hop +4.1 at top-10 (p = 0.55), single-hop and open-domain unchanged. 77
questions flipped to correct against 23 the other way at top-10.

Mechanism: the answerer was being asked to reason chronologically over memories
that carried no dates and, within a session, no order. Both properties existed in
the ledger and were dropped at the adapter boundary. Restoring them is not a
retrieval improvement, retrieval was already finding the evidence: F4's audit
measured temporal gold recall at 84 to 98 percent while accuracy sat at 34
percent. A single traced example makes it concrete: the gold turn "I went to a
LGBTQ support group yesterday" was retrieved at rank 0 both before and after, and
the answer went from "21 October 2023" to "07 May, 2023" against a gold of 7 May
2023, with retrieval unchanged.

Decision: report these as corrections, not as innovations. The honest framing is
that reMem was handicapping itself and the earlier numbers were artificially
depressed, not that these are artificially high. The claim to make is narrow and
mechanical: **an append-only ledger only helps if its order and timestamps survive
to the answerer.** That is a real finding about memory-system plumbing, and it is
the kind of defect that produces plausible numbers with no visible failure.

F4's conclusion is unchanged and is now better bounded. The belief layer is worth
+2.3 at top-50 (p = 0.035) once, in the tail, and promoting beliefs into
contention costs a point. The 13 to 14 point jump is plumbing.

Caveats: the three changes landed together, so their individual contributions are
not separable; temporal carrying all of it points at the `created_at` fix, but
that is inference. Multi-hop remains the one genuine deficit against mem0's
published 90.5 on this harness. Open-domain is n = 21 throughout and its
movements are noise.

Follow-up (F6): the mem0 column on record was run in July with `gpt-4o-mini` as
both answerer and judge, so it is not regime-matched to columns A through D and
the two should not be placed in one table without saying so. A fresh mem0 column
on the current models is required before any head-to-head claim. It is currently
blocked: the harness pins `mem0ai @ git+https://github.com/mem0ai/mem0.git@feat/v3-pipeline`,
a branch that no longer resolves, and the column also needs Docker, which is not
available on this machine.

## F4 - The belief layer is additive, not substitutive: +2.3 at top-50 only when beliefs do not displace observations (2026-08-07)

Run: mem0's `mem0ai/memory-benchmarks` LoCoMo harness, `oss` backend, 3
conversations, n = 385, categories 1-4, top_k 50, cutoffs 10 and 50. Answerer
`openai/gpt-5-mini`, judge `anthropic/claude-sonnet-5` (cross-vendor, so the
self-judging critique closed in F3-b stays closed), both via OpenRouter.
Consolidator held at `gpt-4o-mini` because it is the treatment under test, not
the measuring instrument. Local MiniLM embedder, alpha 0.3, minScore 0.
Artifacts: `eval/results/ablation-2026-08-06/`.

This is the first ablation of the belief layer against itself. Every prior
comparison, including the 2026-07-16 head-to-head, measured reMem against
another system and could not say which part of reMem was responsible.

Three columns, identical in every respect except how beliefs are treated:

| Column | Consolidator | Ranking            | Beliefs                                                             |
| ------ | ------------ | ------------------ | ------------------------------------------------------------------- |
| A      | off          | observations-first | none exist                                                          |
| B      | on           | observations-first | exist, ranked after every observation (slots ~39-50)                |
| C      | on           | blended            | compete with observations on the commensurate pre-attenuation score |

Accuracy (LLM-judge, n = 385):

| Cutoff | A     | B     | C     |
| ------ | ----- | ----- | ----- |
| top-10 | 66.8% | 68.1% | 67.0% |
| top-50 | 75.6% | 77.9% | 76.9% |

Paired McNemar exact tests:

| Comparison | top-10          | top-50              |
| ---------- | --------------- | ------------------- |
| A to B     | +1.3, p = 0.227 | **+2.3, p = 0.035** |
| B to C     | -1.0, p = 0.503 | -1.0, p = 0.481     |
| A to C     | +0.3, p = 1.000 | +1.3, p = 0.267     |

Observation: exactly one cell in the matrix is significant, A to B at top-50.
Beliefs added as supplementary depth in the tail of the window are worth 2.3
points. Beliefs promoted into contention for head slots (C) are worth nothing
further, and are nominally 1.0 point worse than leaving them in the tail. The
configuration built specifically to give beliefs their best chance did not
improve on the configuration that keeps them out of the way.

Per category, nothing survives testing. Multi-hop at top-10 looks encouraging
(A 66.2 to C 71.6, +5.4) but p = 0.344. Open-domain's +9.5 is n = 21. Temporal
moves -4.4 under C, consistent with beliefs displacing dated raw turns out of
the window, but p = 0.219.

Mechanism: a belief that enters the head displaces a raw dialogue turn. The
belief is a distilled statement; the turn is verbatim evidence with a speaker
prefix and a timestamp. On episodic QA the answerer needs the evidence more than
it needs the summary, so the substitution is roughly neutral and slightly
negative on time-sensitive questions. Beliefs help only where they cost nothing,
which is the tail. This is the same effect measured independently in "Fidelity
Before Structure" (arXiv 2601.00821), where verbatim chunks beat LLM-extracted
artifacts by 15.9 points on LoCoMo, and it is what the internal audit predicted
before the run.

Decision: the defensible claim is narrow and mechanistic. Consolidated beliefs
improve episodic QA by 2.3 points at top-50 when added as supplementary depth;
promoting them to compete with raw turns yields no further gain. **The belief
layer's value on this benchmark is additive, not substitutive.** Do not claim
the belief layer explains reMem's standing against other systems: A, which has
no beliefs at all, already scores 66.8 / 75.6.

This bounds the contribution rather than refuting it, and it is consistent with
F1-exp (beliefs-first collapses episodic recall) and F3 (beliefs win on
preference following, where distillation has a clear target). LoCoMo is episodic
recall, the axis this project's own design notes said the belief layer should
not win on. The abilities it was built for, contradiction resolution and
abstention, are not measured here at all.

Follow-up (F5): stop optimising LoCoMo for the belief layer. The next
measurement should be a benchmark that scores the abilities the architecture
targets. BEAM names contradiction resolution, event ordering, and abstention as
first-class categories, and published methods sit at 0.00 to 0.05 on
contradiction resolution and 0.17 to 0.22 on event ordering. A floor that low is
where an ordered, supersession-aware ledger should show an effect if it has one.
Retrieval work (windowed rendering, lexical and entity signals) remains worth
doing for the benchmark numbers, but it is a separate track from validating the
thesis and should not be reported as evidence for it.

Validity notes: the harness required a transport-level patch to unwrap
markdown-fenced JSON from the judge before parsing; it changes no judgement and
was applied identically to all three columns. Top-20 was not run, to control
cost. One earlier attempt at column A was discarded after the harness's on-disk
ingest checkpoint outlived the adapter's in-memory store, so it searched an empty
index and scored 7.5% with `search_results: []` on all 385 questions; every
column reported here passed an explicit non-empty-retrieval gate before scoring.
Column C originally specified a `quota` ranking mode, which a smoke test showed
placed beliefs at positions 39-45 and would have duplicated column B; it was
changed to `blended` before spending.

## F3-c - The belief lead is form-dependent: persona-driven flips it (2026-07-14)

Run: PrefEval `persona-driven`, 150 instances, 50 distractor turns, LLM
consolidator (batch 1), transformers embedder, k = 5, same two-pass protocol as
F3 (offline grounding, then answerer + judge via OpenRouter
`openai/gpt-4o-mini`). Purpose: test whether beliefs-first wins on the hardest
form, where the preference is woven across 4-8 turns and never stated verbatim.
Artifacts: `eval/results/prefeval-persona-driven-2026-07-14-t50/`.

Preference following (LLM answer + LLM judge, 150 instances):

| System       | Follow rate | Follows | Violates | Unaware | Hallucinate | Gap    |
| ------------ | ----------- | ------- | -------- | ------- | ----------- | ------ |
| naive-vector | 50.7%       | 76      | 65       | 8       | 1           |        |
| reMem        | 54.7%       | 82      | 54       | 13      | 1           | +4.0pp |

Retrieval (grounded accuracy, beliefs-first reMem vs naive-vector):

| System       | Recall@5 | MRR   | Grounded |
| ------------ | -------- | ----- | -------- |
| naive-vector | 90.7%    | 0.761 | 64.0%    |
| reMem        | 86.7%    | 0.702 | 56.7%    |

Observation: the prediction was that persona-driven would be reMem's largest
win, because the preference is never stated in one turn so naive has nothing
verbatim to retrieve. The opposite happens. reMem's follow-rate edge collapses
to +4.0pp (inside noise, 82 vs 76 follows of 150), and reMem loses the
retrieval axis outright: Recall@5 86.7% vs 90.7%, MRR 0.702 vs 0.761, grounded
56.7% vs 64.0%. Contrast choice-based at the same t50, where reMem won
retrieval 89.3% vs 67.3% and follow rate by +26.7pp. The form flips the result.

Mechanism: persona-driven distributes the preference across many redundant turns.
That redundancy is exactly what dense vector retrieval is good at: several turns
independently support the preference, so naive catches at least one at high rank
(90.7% recall). Consolidation compresses that redundant evidence into a smaller
set of belief statements, and the compression loses fidelity, so beliefs-first
ranks a distilled-but-lossy statement over the raw supporting turns and
underperforms. reMem violates less (54 vs 65) but goes unaware more (13 vs 8):
faced with a compressed, less-certain belief it hedges rather than commits,
which trades violations for abstentions and nets only a marginal follow gain.

Decision: beliefs-first is not universally superior on preference following. It
wins when the preference is concentrated in one distillable or semi-explicit
turn (explicit, choice-based), and it does not win, and can hurt retrieval, when
the signal is diffuse across many redundant turns (persona-driven). State this
as a scope boundary, not a failure: the belief layer adds value where
consolidation has a clear target to distill, and raw retrieval is preferable
where redundancy already surfaces the signal. This sharpens the two-axis story
into a three-regime map (concentrated-explicit / concentrated-implicit /
diffuse) rather than a blanket "beliefs win" claim. The cross-vendor judge check
(F3-b) is low value here because the follow-rate gap is within noise; the
finding is the retrieval regression, not judge reliability.

## F3-b - The follow-rate lead survives a different-vendor judge (2026-07-14)

Run: PrefEval `choice-based`, 40 instances, 50 distractor turns, LLM
consolidator (batch 1), k = 5. Each answer is generated once by the answerer
(`openai/gpt-4o-mini`) and then graded by two judges: judge A = the same
`openai/gpt-4o-mini`, judge B = `google/gemini-2.5-flash` (different vendor).
Zero answer variance between judges, so any difference is pure judge
disagreement. Purpose: kill the self-judging critique (answerer and F3 judge
are the same model). Artifact:
`eval/results/prefeval-choice-based-2026-07-14-t50-judge2/`.

| System       | Follow (judge A, gpt-4o-mini) | Follow (judge B, gemini-2.5-flash) | Label agree | Follow agree | Cohen kappa |
| ------------ | ----------------------------- | ---------------------------------- | ----------- | ------------ | ----------- |
| naive-vector | 35.0% (14/40)                 | 35.0% (14/40)                      | 77.5%       | 90.0%        | 0.780       |
| reMem        | 55.0% (22/40)                 | 60.0% (24/40)                      | 85.0%       | 95.0%        | 0.898       |

reMem - naive gap: +20.0pp under judge A, +25.0pp under judge B.

Observation: the reMem lead does not depend on the answerer grading itself. It
survives a fully independent, different-vendor judge and in fact widens slightly
(+20.0pp -> +25.0pp) because gemini scores reMem marginally more favorably.
Both judges agree strongly (kappa 0.78 naive, 0.90 reMem; follow agreement 90 /
95%), and reMem cases are the cleaner, higher-agreement ones. The self-judging
critique is dead.

Decision: F3 is judge-robust and defensible end to end. This was the blocker on
a public writeup. Caveat to keep: single form (choice-based) at this sample;
persona-driven at scale is the remaining harder case.

## F3-a - The belief lead is large and flat across distractor density, not growing (2026-07-14)

Run: PrefEval `choice-based`, 150 instances, distractor sweep at 10 / 50 / 100
off-topic turns, LLM consolidator (batch 1, per-turn), transformers embedder,
k = 5. Post-fix: includes the F3 consolidator/answerer fixes (commit `1f9e00f`)
that force preference beliefs, preserve negations, and strip the tag prefix for
the answerer. Same two-pass protocol as F3 (offline grounding, then answerer +
judge via OpenRouter `openai/gpt-4o-mini`). Artifacts:
`eval/results/prefeval-choice-based-2026-07-14-t10/`, `-t50/`, `-t100/`.

Preference following (LLM answer + LLM judge, 150 instances):

| Distractors | System       | Follow rate | Follows | Violates | Unaware | Hallucinate | Gap     |
| ----------- | ------------ | ----------- | ------- | -------- | ------- | ----------- | ------- |
| 10          | naive-vector | 49.3%       | 74      | 70       | 6       | 0           |         |
| 10          | reMem        | 69.3%       | 104     | 40       | 5       | 1           | +20.0pp |
| 50          | naive-vector | 45.3%       | 68      | 72       | 10      | 0           |         |
| 50          | reMem        | 72.0%       | 108     | 37       | 5       | 0           | +26.7pp |
| 100         | naive-vector | 46.0%       | 69      | 74       | 7       | 0           |         |
| 100         | reMem        | 66.0%       | 99      | 46       | 4       | 1           | +20.0pp |

Retrieval (grounded accuracy, beliefs-first reMem vs naive-vector):

| Distractors | naive Recall@5 / MRR / Grounded | reMem Recall@5 / MRR / Grounded |
| ----------- | ------------------------------- | ------------------------------- |
| 10          | 67.3% / 0.366 / 18.7%           | 89.3% / 0.601 / 36.0%           |
| 50          | 62.0% / 0.346 / 18.7%           | 85.3% / 0.592 / 38.7%           |
| 100         | 61.3% / 0.339 / 18.0%           | 84.7% / 0.543 / 30.7%           |

Observation: the F3 follow-up predicted the belief edge would widen as distractor
pressure decayed naive recall of the semi-explicit turn. It does not. The judge
lead is large and roughly flat: +20.0pp at t10, +26.7pp at t50, +20.0pp at t100,
a slight bump at t50 rather than a monotone climb. naive-vector sits near a
coin flip at every density (45-49%), while reMem holds ~66-72% and roughly
halves violations. A pre-fix t10 run had shown only +4.0pp (55.3% vs 51.3%),
which appeared to support the widening story; that gap was a consolidator
artifact, and the fix lifts reMem hardest at low density, flattening the curve.

Mechanism: two axes move differently under noise. The retrieval axis does behave
as predicted, reMem's grounded/MRR margin over naive grows as distractors
climb (naive grounding decays 18.7 -> 18.0%, reMem stays 36-38% through t50),
because beliefs-first keeps the distilled preference statement at rank 1 while
naive's semi-explicit turn sinks under distractors. But that retrieval margin is
answerer-gated: the judge only sees the top-k snippets, and once the right
statement is present the answerer's follow decision saturates, so a wider recall
lead does not convert into a wider follow-rate lead. reMem itself softens at
t100 (72 -> 66%, violations 37 -> 46) as doubled distractors leak into the
consolidation window and the top-k, which offsets naive's own slow decay and
holds the gap near +20pp.

Decision: the defensible F3 claim is a large, consistent belief lead across
densities (+20-27pp), robust to noise but not growing with it. Drop the
"edge widens with distraction" framing for follow-rate; reserve the widening
language for the retrieval axis only, and flag that it is answerer-gated.

Follow-up (F3-b): the answerer and judge are the same model (`gpt-4o-mini`),
so before any public write-up run a second judge model over a sample to preempt
the self-judging critique. This sweep is single-form (choice-based); the
persona-driven form (preference woven across 4-8 turns, never selected) is the
harder case where naive has no single turn to latch onto, still unrun at scale.
The residual reMem violations (~40-46) are answerer drift off a correct belief;
tightening the answerer prompt to treat "Known about the user" as hard
constraints is the next lever.

## F3 - Beliefs-first flips the ranking and doubles grounding on PrefEval (2026-07-13)

Run: PrefEval `choice-based`, 40 instances, 10 off-topic distractor turns each,
LLM consolidator (batch 8), transformers embedder, k = 5. First belief-vs-baseline
number on a preference benchmark, the axis LoCoMo cannot show. Two passes: offline
retrieval grounding, then the preference-following judge (answerer LLM + judge LLM,
two live calls per sample per scored system) routed through OpenRouter
(`openai/gpt-4o-mini`). Beliefs are rendered to the answerer for reMem only, so
the comparison isolates the belief layer. Artifacts:
`eval/results/prefeval-choice-based-2026-07-13-t10/` (summary.md +
follow-rate.md/json).

Retrieval (40 instances):

| System                         | Recall@5 | MRR   | Grounded acc |
| ------------------------------ | -------- | ----- | ------------ |
| naive-vector                   | 67.5%    | 0.404 | 22.5%        |
| reMem (beliefs-first)          | 80.0%    | 0.551 | 40.0%        |
| reMem-obs (observations-first) | 77.5%    | 0.403 | 17.5%        |
| reMem-blend                    | 77.5%    | 0.411 | 17.5%        |

Preference following (LLM answer + LLM judge):

| System       | Follow rate | Follows | Violates | Unaware | Hallucinate |
| ------------ | ----------- | ------- | -------- | ------- | ----------- |
| naive-vector | 55.0%       | 22      | 14       | 4       | 0           |
| reMem        | 60.0%       | 24      | 15       | 1       | 0           |

Observation: on PrefEval the ranking order inverts from LoCoMo. Beliefs-first is
the winning reMem mode (grounded 40.0%), and observations-first, the LoCoMo
default, is the worst reMem mode here (17.5%, below even naive-vector). With
beliefs formed, reMem grounding nearly doubles naive-vector (40.0% vs 22.5%) and
leads on recall@5 and MRR. The judge win is real but modest at this pressure
(+5pp, 60.0% vs 55.0%); its clearest signal is the collapse of "unaware" answers
from 4 to 1, meaning the consolidated preference reaches the answerer where the
raw turn did not.

Mechanism: choice-based instances imply the preference through an option
selection ("I'll go with option 1"), so the gold turn is only semi-explicit. A
raw retriever can still surface that turn (naive-vector recall@5 67.5%), but the
answerer often cannot act on it because the turn never states the preference. The
belief layer distills the selection into an explicit statement
(`canonicalBeliefText`), and beliefs-first ranking puts that statement at the top
of the pack, which is why grounding doubles and "unaware" nearly vanishes. The
judge gap stays small because at 10 distractor turns naive-vector still recalls
the semi-explicit turn often enough to answer many cases correctly; the belief
edge should widen as distractor pressure grows.

Decision: PrefEval is the belief layer's benchmark and beliefs-first is its mode,
the exact opposite of the LoCoMo default. This confirms the two axes are distinct:
episodic recall (LoCoMo, observations-first) and durable-preference following
(PrefEval, beliefs-first). Both modes ship; the eval picks the right one per task.

Follow-up (F3-a): the +5pp judge gap is measured at a single, low pressure point.
Run a distractor sweep (`--turns=10/50/100`) to test the prediction that the
belief edge widens as raw recall of the semi-explicit turn decays, then extend to
the persona-driven form (preference woven across 4-8 turns, never selected) where
naive retrieval has no single turn to latch onto and the belief win should be
largest. Scale to ~150 instances for tighter follow-rate confidence intervals.

## F2 - Retrieval lead converts to 2.1x QA accuracy on the full set (2026-07-13)

Run: `locomo10`, all 10 dialogues, 1531 answerable cases, LLM consolidator
(batch 1, per-turn), transformers embedder, k = 5. First full LLM-judged QA pass
(answerer + judge, two live calls per case per system) over the entire
answerable set. Routed through OpenRouter (`openai/gpt-4o-mini`) to clear the
OpenAI tier-1 10k requests/day cap that aborted the earlier direct run at
250/1531. QA scored for the baseline and the chosen default only. Artifacts:
`eval/results/locomo-2026-07-13/` (summary.md + qa-accuracy.md/json).

Retrieval (all 10 dialogues):

| System                         | Recall@5 | MRR   | Grounded acc | Extraction acc |
| ------------------------------ | -------- | ----- | ------------ | -------------- |
| naive-vector                   | 18.6%    | 0.132 | 6.9%         | 8.9%           |
| reMem (beliefs-first)          | 23.9%    | 0.155 | 5.9%         | 7.6%           |
| reMem-obs (observations-first) | 43.2%    | 0.323 | 18.2%        | 23.5%          |
| reMem-blend                    | 42.2%    | 0.315 | 17.7%        | 22.8%          |

QA accuracy (LLM answer + LLM judge, answerable set):

| System       | QA accuracy | Correct | Cases |
| ------------ | ----------- | ------- | ----- |
| naive-vector | 11.6%       | 178     | 1531  |
| reMem-obs    | 24.3%       | 372     | 1531  |

Observation: the observations-first retrieval lead survives end-to-end.
reMem-obs answers 24.3% of the full answerable set correctly against
naive-vector's 11.6%, a 2.1x gain on the axis directly comparable to published
LoCoMo numbers (Mem0, MemGPT). The full-set result tracks the 3-dialogue pilot
(22.3% vs 8.9%), so the effect is stable, not a small-sample artifact.

Mechanism: QA accuracy is a function of whether the gold turn lands in the top-k
snippets handed to the answerer (`qa-judge.ts contextSnippets` renders raw
observation content, not beliefs). reMem-obs roughly doubles recall@5 over
naive-vector (43.2% vs 18.6%) by ranking raw vector/BM25 hits first and letting
belief provenance augment the tail, so the answerer sees the supporting turn far
more often. The retrieval-to-answer ratio is consistent across systems (~0.56
QA / recall for reMem-obs, ~0.62 for naive-vector), which is expected: the
answerer and judge behave the same regardless of which system supplied the
snippets, so the QA gap is inherited almost entirely from the recall gap.

Decision: this is the headline result for LoCoMo. reMem-obs is the shipped
default and the number to quote. The belief layer's own axis (supersession,
abstention on durable preferences) is still unmeasured here by design, LoCoMo
penalizes distillation, so a preference benchmark like PrefEval remains the next
target to show a belief-first win.

Follow-up (F2-a): the belief store is rebuilt from scratch every run (~5k LLM
calls, ~2.5h of the ~3.5h wall time). Persisting it to disk decouples the build
from scoring and makes QA reruns (prompt tweaks, k sweeps, batch=1 vs batch=8
fidelity check) cost only the ~6.1k scoring calls. Adds the reusable cache
before the next iteration.

## F1-exp - Observations-first ranking fixes both recall and grounding (2026-07-11)

Run: `locomo10`, 1977 cases (1531 extraction, 446 abstention), LLM-backed
consolidator (batch 1, all 10 dialogues), transformers embedder, k = 5. Three
ranking modes scored in one pass. Artifact:
`eval/results/locomo-2026-07-11-3mode-llm-full/` (report.json + summary.md).

| System                         | Recall@5 | MRR   | Grounded acc | Extraction acc |
| ------------------------------ | -------- | ----- | ------------ | -------------- |
| naive-vector                   | 18.6%    | 0.132 | 6.9%         | 8.9%           |
| reMem (beliefs-first)          | 18.4%    | 0.127 | 4.5%         | 5.7%           |
| reMem-obs (observations-first) | 42.8%    | 0.323 | 18.2%        | 23.5%          |
| reMem-blend (interleaved)      | 40.8%    | 0.316 | 18.1%        | 23.4%          |

Observation: the F1 regression was an artifact of ranking order, not the belief
layer itself. Beliefs-first is the worst mode (recall 18.4%, extraction 5.7%,
barely matching naive-vector on recall and losing on grounding). Flipping to
observations-first is a decisive win across every metric: recall 18.4 -> 42.8%
(2.3x), extraction 5.7 -> 23.5% (4.1x), MRR 0.127 -> 0.323. Blended trails obs by
a hair on all axes, so pure observations-first is the pick.

Mechanism: `rankPackToEvalIds` (systems.ts) in beliefs-first mode emits
belief-provenance observations ahead of raw observation hits. On LoCoMo (episodic
QA), the LLM distills dialogues into a few durable facts, and their provenance
turns are usually not the gold evidence turns the questions ask about, so
distillation buries the exact episodic turns needed and both top-1 grounding and
recall collapse. Observations-first restores the raw vector hits to the front and
lets belief provenance augment rather than displace them: the episodic evidence
is recovered while beliefs still contribute unique gold turns into the top-5.

Decision: make observations-first the default ranking mode. The belief layer is
retained as an augmentation, not a replacement for observation ranking. Confirms
the earlier hybrid-mode hypothesis directly.

Follow-up (F1-exp validated F2): the 1-dialogue divergence check
(`eval/results/locomo-2026-07-11-smoke-1dlg/`) predicted this exact direction
(obs 32.9% recall / 19.5% extraction vs beliefs 14.8% / 3.4%) and the full run
confirmed it. Abstention stays 0% across all modes (MiniLM ~0.5 baseline cosine
clears the 0.3 floor); ranking order does not touch abstention, that is a separate
thresholding problem. LoCoMo rewards episodic recall and structurally penalizes
distillation, so the belief layer's real strengths (supersession, abstention on
durable preferences) still want a preference benchmark like PrefEval to show a
win.

## F1 - Belief-first ranking wins recall but loses top-1 grounding (2026-07-11)

Run: `locomo10`, 1977 cases (1531 extraction, 446 abstention), LLM-backed
consolidator, transformers embedder, k = 5. Results in
`eval/results/locomo-2026-07-11/`.

| System       | Recall@5 | MRR   | Grounded acc | Extraction acc |
| ------------ | -------- | ----- | ------------ | -------------- |
| naive-vector | 18.6%    | 0.132 | 6.9%         | 8.9%           |
| reMem        | 22.3%    | 0.145 | 5.7%         | 7.3%           |

Observation: reMem beats naive-vector on recall@5 (+3.7 pts) and MRR, but loses
on grounded extraction accuracy (7.3% vs 8.9%).

Mechanism: grounded accuracy (`metrics.ts isGrounded`) rewards only the top-1
ranked observation being a current gold supporting one. ReMem's
`rankPackToEvalIds` (systems.ts) always emits belief-provenance observations
first, raw observations second. When a belief's provenance observation is not the
gold supporting one (stale provenance, or a broad belief whose first-listed
justification is not the exact fact the question asks for), the wrong observation
takes the top-1 slot. Belief provenance still lands a gold within the top-5, so
recall@5 rises while top-1 grounding falls. Better breadth, worse precision at
rank 1.

Follow-up (F1-exp): test alternative pack-to-id orderings that do not force
beliefs ahead of the direct observations. Variants: `observations-first` (raw
observation hits before belief provenance) and `blended` (interleave by pack
score). Hypothesis: an observation-aware ordering recovers extraction grounding
without giving back the recall@5 gain. See F1-exp entry once the run lands.
