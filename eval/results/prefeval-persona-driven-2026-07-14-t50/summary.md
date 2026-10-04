# ReMem evaluation: prefeval-persona-driven

Generated 2026-07-14T23:34:55.347Z. Recall cutoff k = 5.

Grounded accuracy is the headline number: for answerable cases the top-ranked observation must be a current supporting one; for unanswerable cases the system must abstain. It rewards surfacing the right fact and penalizes both stale answers and confident guesses.

## Overview

| System | Recall@5 | MRR | Grounded acc | Abstain P | Abstain R | Tokens/query | Latency (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| no-memory | 0.0% | 0.000 | 0.0% | 0.0% | 100.0% | 0.0 | 0.00 |
| naive-vector | 90.7% | 0.761 | 64.0% | 100.0% | 100.0% | 476.0 | 0.12 |
| reMem | 86.7% | 0.702 | 56.7% | 100.0% | 100.0% | 242.5 | 0.00 |
| reMem-obs | 84.7% | 0.640 | 51.3% | 100.0% | 100.0% | 242.5 | 0.00 |
| reMem-blend | 85.3% | 0.649 | 51.3% | 100.0% | 100.0% | 242.5 | 0.00 |

## Grounded accuracy by ability

| System | Preference following |
| --- | --- |
| no-memory | 0.0% |
| naive-vector | 64.0% |
| reMem | 56.7% |
| reMem-obs | 51.3% |
| reMem-blend | 51.3% |
