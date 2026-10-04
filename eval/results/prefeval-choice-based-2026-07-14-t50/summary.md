# ReMem evaluation: prefeval-choice-based

Generated 2026-07-14T04:10:49.416Z. Recall cutoff k = 5.

Grounded accuracy is the headline number: for answerable cases the top-ranked observation must be a current supporting one; for unanswerable cases the system must abstain. It rewards surfacing the right fact and penalizes both stale answers and confident guesses.

## Overview

| System | Recall@5 | MRR | Grounded acc | Abstain P | Abstain R | Tokens/query | Latency (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| no-memory | 0.0% | 0.000 | 0.0% | 0.0% | 100.0% | 0.0 | 0.00 |
| naive-vector | 62.0% | 0.346 | 18.7% | 100.0% | 100.0% | 238.1 | 0.10 |
| reMem | 85.3% | 0.592 | 38.7% | 100.0% | 100.0% | 238.5 | 0.00 |
| reMem-obs | 83.3% | 0.278 | 5.3% | 100.0% | 100.0% | 238.5 | 0.00 |
| reMem-blend | 84.7% | 0.338 | 7.3% | 100.0% | 100.0% | 238.5 | 0.00 |

## Grounded accuracy by ability

| System | Preference following |
| --- | --- |
| no-memory | 0.0% |
| naive-vector | 18.7% |
| reMem | 38.7% |
| reMem-obs | 5.3% |
| reMem-blend | 7.3% |
