# ReMem evaluation: prefeval-choice-based

Generated 2026-07-14T08:23:41.665Z. Recall cutoff k = 5.

Grounded accuracy is the headline number: for answerable cases the top-ranked observation must be a current supporting one; for unanswerable cases the system must abstain. It rewards surfacing the right fact and penalizes both stale answers and confident guesses.

## Overview

| System | Recall@5 | MRR | Grounded acc | Abstain P | Abstain R | Tokens/query | Latency (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| no-memory | 0.0% | 0.000 | 0.0% | 0.0% | 100.0% | 0.0 | 0.00 |
| naive-vector | 67.3% | 0.366 | 18.7% | 100.0% | 100.0% | 139.9 | 0.03 |
| reMem | 89.3% | 0.601 | 36.0% | 100.0% | 100.0% | 235.1 | 0.00 |
| reMem-obs | 89.3% | 0.378 | 11.3% | 100.0% | 100.0% | 235.1 | 0.00 |
| reMem-blend | 89.3% | 0.398 | 12.0% | 100.0% | 100.0% | 235.1 | 0.00 |

## Grounded accuracy by ability

| System | Preference following |
| --- | --- |
| no-memory | 0.0% |
| naive-vector | 18.7% |
| reMem | 36.0% |
| reMem-obs | 11.3% |
| reMem-blend | 12.0% |
