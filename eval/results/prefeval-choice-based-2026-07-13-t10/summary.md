# ReMem evaluation: prefeval-choice-based

Generated 2026-07-13T04:56:25.737Z. Recall cutoff k = 5.

Grounded accuracy is the headline number: for answerable cases the top-ranked observation must be a current supporting one; for unanswerable cases the system must abstain. It rewards surfacing the right fact and penalizes both stale answers and confident guesses.

## Overview

| System | Recall@5 | MRR | Grounded acc | Abstain P | Abstain R | Tokens/query | Latency (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| no-memory | 0.0% | 0.000 | 0.0% | 0.0% | 100.0% | 0.0 | 0.00 |
| naive-vector | 67.5% | 0.404 | 22.5% | 100.0% | 100.0% | 134.2 | 0.09 |
| reMem | 80.0% | 0.551 | 40.0% | 100.0% | 100.0% | 237.1 | 0.00 |
| reMem-obs | 77.5% | 0.403 | 17.5% | 100.0% | 100.0% | 237.1 | 0.00 |
| reMem-blend | 77.5% | 0.411 | 17.5% | 100.0% | 100.0% | 237.1 | 0.00 |

## Grounded accuracy by ability

| System | Preference following |
| --- | --- |
| no-memory | 0.0% |
| naive-vector | 22.5% |
| reMem | 40.0% |
| reMem-obs | 17.5% |
| reMem-blend | 17.5% |
