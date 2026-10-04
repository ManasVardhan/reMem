# ReMem evaluation: locomo10

Generated 2026-07-13T02:07:13.190Z. Recall cutoff k = 5.

Grounded accuracy is the headline number: for answerable cases the top-ranked observation must be a current supporting one; for unanswerable cases the system must abstain. It rewards surfacing the right fact and penalizes both stale answers and confident guesses.

## Overview

| System | Recall@5 | MRR | Grounded acc | Abstain P | Abstain R | Tokens/query | Latency (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| no-memory | 0.0% | 0.000 | 22.6% | 22.6% | 100.0% | 0.0 | 0.00 |
| full-context | 0.3% | 0.010 | 0.1% | 100.0% | 0.0% | 18690.0 | 0.07 |
| naive-vector | 18.6% | 0.132 | 6.9% | 100.0% | 0.0% | 79.3 | 0.50 |
| reMem | 23.9% | 0.155 | 5.9% | 100.0% | 0.0% | 161.1 | 0.00 |
| reMem-obs | 43.2% | 0.323 | 18.2% | 100.0% | 0.0% | 161.1 | 0.00 |
| reMem-blend | 42.2% | 0.315 | 17.7% | 100.0% | 0.0% | 161.1 | 0.00 |

## Grounded accuracy by ability

| System | Extraction | Abstention |
| --- | --- | --- |
| no-memory | 0.0% | 100.0% |
| full-context | 0.1% | 0.0% |
| naive-vector | 8.9% | 0.0% |
| reMem | 7.6% | 0.0% |
| reMem-obs | 23.5% | 0.0% |
| reMem-blend | 22.8% | 0.0% |
