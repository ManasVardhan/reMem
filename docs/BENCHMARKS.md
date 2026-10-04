# ReMem: Benchmarks and Metrics

This document defines how we measure whether the kernel actually works. A memory
layer is only as good as its recall quality, its ability to track change, and
its cost. We evaluate on four axes:

1. **Long-term QA** - can it answer questions that require remembering earlier
   sessions? (LoCoMo, LongMemEval)
2. **Deep memory reasoning** - can it reason over very long histories, not just
   retrieve a fact? (BEAM)
3. **Personalization** - does it follow _this_ user's evolving preferences and
   abstain when it should? (PrefEval, PersonaMem, LaMP)
4. **Systems cost** - tokens per query, added latency, storage footprint.

The design bet (ledger + confidence + decay + scope + provenance) should pay off
most on the axes existing systems ignore: preference _change_, contradiction
handling, and abstention. Those are exactly what axes 3 and (parts of) 1 stress.

---

## 1. LoCoMo (Long Conversational Memory)

- **What it is.** Very long multi-session dialogues (avg ~300 turns, ~9K tokens
  across up to 35 sessions) with QA over the conversation. The de facto headline
  benchmark for conversational memory systems; mem0, Zep, and others report on
  it.
- **Question categories.** single-hop, multi-hop, temporal, open-domain,
  adversarial (the last tests whether the system correctly says "not answerable").
- **Why we use it.** It is the standard the field compares on, so it makes our
  numbers legible. Its temporal and adversarial slices map directly to our decay
  and abstention claims.
- **Known caveats.** The dataset has label-noise and some ceiling effects;
  strong long-context baselines do well. We therefore treat LoCoMo as necessary
  but not sufficient, and lean on LongMemEval and BEAM for signal.
- **Reference numbers.** mem0 reports ~66% (LLM-judge) on the full set and
  markets ~26% higher than OpenAI memory with ~91% lower p95 latency and ~90%
  token savings vs full-context. Full-context (stuff everything in the prompt)
  is the accuracy ceiling but the cost floor.

**Primary metric:** LLM-as-judge answer correctness (J), per-category and overall.
**Secondary:** F1 / BLEU-1 against reference answers; tokens/query; p50/p95 latency.

---

## 2. LongMemEval

- **What it is.** 500 curated questions over long, evolving chat histories, built
  to isolate five core abilities: information extraction, multi-session
  reasoning, temporal reasoning, knowledge updates, and abstention. Distractor
  history is injected so the model must retrieve, not just read.
- **Why we use it.** It is the cleanest test of the exact capabilities we
  designed for. **Knowledge updates** = our CONTRADICT/supersede path.
  **Abstention** = our confidence floor. **Temporal reasoning** = our decay and
  `last_reinforced_ts`. If ReMem's architecture is worth anything, it should
  show up here more than on LoCoMo.
- **Reference numbers.** Retrieval matters a lot: BM25 alone ~86% on the QA
  subset; **BM25 + vector hybrid ~95%**; pure dense retrieval underperforms.
  This directly justifies the hybrid recall in DESIGN.md step 2. End-to-end QA
  accuracy for full systems sits well below the oracle-retrieval number, which
  is where a good kernel earns its keep.

**Primary metric:** QA accuracy (LLM-judge), broken out by the five abilities.
**Secondary:** retrieval recall@k and MRR at the chunk/observation level (so we
can separate "retrieved the right thing" from "answered correctly");
abstention precision/recall on the unanswerable slice.

---

## 3. BEAM (deep, book-length memory)

- **What it is.** A 2025 benchmark for very long histories (100K to 10M tokens)
  probing 10 memory abilities across retrieval, reasoning over memory, and
  long-range consistency. Designed specifically because LoCoMo/LongMemEval are
  saturating.
- **Why we use it.** It is the hard ceiling. It stresses whether beliefs stay
  consistent and retrievable when the ledger is enormous, which is the regime a
  real always-on assistant eventually lives in.
- **Reference numbers.** Even strong LLM + memory-framework combinations score
  in the ~50-60% range at the long end, so there is real headroom and the
  benchmark discriminates well between systems.

**Primary metric:** per-ability accuracy and macro average.
**Secondary:** degradation curve vs history length (accuracy at 128K vs 1M vs
10M tokens) - this is our scalability story.

---

## 4. Personalization: PrefEval, PersonaMem, LaMP

These target the "tailor-made to the user" claim, which the QA benchmarks above
mostly do not.

- **PrefEval.** Benchmarks whether an assistant _follows_ a user's stated
  preferences in long conversations (20+ turns), including when preferences are
  implicit or conflict. Baselines are poor (models routinely drop below ~10%
  preference-following at long context without help), so there is enormous
  headroom for a real memory layer. This is the single best external test of our
  preference + scope + supersession machinery.
- **PersonaMem.** Tracks evolving personas and whether the system keeps an
  up-to-date model of the user as facts change over time. Maps to our
  REINFORCE/CONTRADICT ops and decay.
- **LaMP.** Language Model Personalization: 7 tasks (personalized classification,
  generation) with per-user profiles. Good for measuring whether recalled
  context actually improves downstream generation, not just retrieval.

**Primary metrics:**

- PrefEval: preference-following accuracy / violation rate over conversation
  length; error-type breakdown (violation, unhelpful, hallucinated preference,
  inconsistent).
- PersonaMem: update-tracking accuracy (does it use the _current_ preference,
  not a stale one).
- LaMP: task-specific (accuracy / F1 / ROUGE) with vs without ReMem context.

---

## 5. Internal / diagnostic evals (ours, not external)

External benchmarks do not directly test kernel internals, so we add targeted
unit-style evals with synthetic-but-labeled data:

- **Contradiction handling.** Scripted sequences ("I use SFO" then "I moved,
  I fly out of OAK now"). Assert: new belief active, old superseded not deleted,
  `why()` cites both, recall returns OAK under matching scope.
- **Decay correctness.** Inject a preference, advance the clock, assert
  effective_confidence follows `base * exp(-lambda * dt)` and that it archives
  below floor while the ledger retains evidence.
- **Scope routing.** "concise in Slack, thorough in docs" - assert recall under
  `surface=slack` returns concise and under `project=paper` returns thorough.
- **Abstention.** Ask about something never observed; assert the kernel returns
  low/empty confidence rather than a confident guess.
- **Provenance integrity.** Every active belief resolves to >=1 observation;
  `why()` never returns an empty set for an active belief.
- **Recomputation.** Re-run consolidation from the ledger with improved logic;
  assert deterministic reducer output is stable and beliefs are re-derivable.

These run in CI on every change; they are fast, deterministic, and catch
regressions the big benchmarks are too coarse to see.

---

## 6. Metric definitions (canonical)

| metric                    | definition                                                         | axis            |
| ------------------------- | ------------------------------------------------------------------ | --------------- |
| J (LLM-judge correctness) | fraction of answers a judge model rates correct vs reference       | QA quality      |
| F1 / BLEU-1 / ROUGE       | lexical overlap with reference answer                              | QA quality      |
| recall@k                  | fraction of queries where a gold observation is in top-k retrieved | retrieval       |
| MRR                       | mean reciprocal rank of the first gold observation                 | retrieval       |
| preference-following rate | fraction of turns respecting the active preference                 | personalization |
| update accuracy           | fraction of queries using the _current_ (not stale) belief         | change tracking |
| abstention P/R            | precision/recall of correctly saying "I don't know"                | trust           |
| tokens/query              | context tokens sent to the answering model per query               | cost            |
| p50 / p95 latency         | added recall latency                                               | cost            |
| storage/1k obs            | DB bytes per 1,000 observations                                    | cost            |

---

## 7. Success criteria (v1 targets)

We are not chasing SOTA on LoCoMo (long-context baselines cap it). We are
proving the architecture. v1 ships when:

- **LongMemEval:** within a few points of the BM25+vector oracle-retrieval
  ceiling on extraction/temporal; **beat a pure-vector mem0-style baseline on
  the knowledge-update and abstention slices** (this is the thesis).
- **PrefEval:** materially higher preference-following than a no-memory and a
  naive-vector-memory baseline at 20+ turns.
- **Cost:** >=80% token reduction vs full-context with <100ms added p50 recall
  latency on a local SQLite DB of ~100k observations.
- **All internal diagnostic evals green** in CI.

We always report against three baselines: (a) no memory, (b) full-context
stuffing (accuracy ceiling / cost floor), (c) naive vector-RAG memory
(mem0-style). ReMem's job is to approach (b)'s accuracy at close to (a)'s cost,
while beating (c) on change/abstention.
