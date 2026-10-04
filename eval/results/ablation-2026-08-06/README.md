# Belief-layer ablation, 2026-08-06

First measurement of whether reMem's belief layer contributes to episodic QA.
Run inside mem0's `memory-benchmarks` LoCoMo harness, `oss` backend mode.

## Shared setup

- 3 conversations, n=385 questions, categories 1-4, top_k 50, cutoffs 10 and 50
- Answerer `openai/gpt-5-mini`, judge `anthropic/claude-sonnet-5` (cross-vendor,
  which closes the self-judging critique), both via OpenRouter
- Consolidator held at `gpt-4o-mini`: it is the treatment under test, not the
  instrument
- Embedder: local MiniLM (transformers), `alpha` 0.3, `minScore` 0

Top-20 was not run. It was dropped to control cost; the argument rests on the
top-10 precision cell and the top-50 recall cell.

## Columns

| Column | Consolidator | Ranking | Beliefs |
| --- | --- | --- | --- |
| A | off | observations-first | none exist |
| B | on | observations-first | exist, ranked after all observations |
| C | on | blended | compete with observations on a commensurate score |

Column C originally specified `quota` ranking. A smoke test on 40 real LoCoMo
turns showed quota placing beliefs at positions 39 to 45, never inside top-10,
which would have made column C a duplicate of column B. See the plan for the
amendment.

## Files

- `config-<X>.json`: the adapter's effective config at run time, captured from
  `/health`, so each column self-documents rather than relying on the log.
- `col<X>-metrics.json`: metadata plus per-cutoff, per-category metrics.
- Full per-question evaluations are omitted for size (about 6 MB per column),
  matching the convention in `external-comparison-2026-07-16`.

## Result

| Cutoff | A no beliefs | B beliefs in tail | C beliefs on merit | D plus fixes |
| --- | --- | --- | --- | --- |
| top-10 | 66.8% | 68.1% | 67.0% | **82.1%** |
| top-50 | 75.6% | 77.9% | 76.9% | **90.9%** |

Temporal (n=90) carries almost all of D's gain: 28.9 to 85.6 at top-10, 34.4 to
95.6 at top-50. Other categories are flat within noise.

Paired McNemar, n=385:

| Comparison | top-10 | top-50 |
| --- | --- | --- |
| A to B, beliefs added | +1.3, p=0.227 | +2.3, p=0.035 |
| B to C, beliefs promoted | -1.0, p=0.503 | -1.0, p=0.481 |
| B to D, the three fixes | +14.0, p=5.5e-08 | +13.0, p=5.3e-08 |

Column D adds `created_at` dating, distinct per-turn timestamps, windowed
rendering, and supersession demotion to column B. Full analysis in
`docs/FINDINGS.md`, entry F5.

The mem0 numbers on record (July: 69.9 top-10, 73.2 top-50) were run with
`gpt-4o-mini` as both answerer and judge and are NOT regime-matched to columns A
through D. Do not place them in one table without saying so.
