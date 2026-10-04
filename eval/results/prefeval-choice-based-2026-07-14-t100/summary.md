# ReMem evaluation: prefeval-choice-based

Generated 2026-07-14T07:07:28.924Z. Recall cutoff k = 5.

Grounded accuracy is the headline number: for answerable cases the top-ranked observation must be a current supporting one; for unanswerable cases the system must abstain. It rewards surfacing the right fact and penalizes both stale answers and confident guesses.

## Overview

| System | Recall@5 | MRR | Grounded acc | Abstain P | Abstain R | Tokens/query | Latency (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| no-memory | 0.0% | 0.000 | 0.0% | 0.0% | 100.0% | 0.0 | 0.00 |
| naive-vector | 61.3% | 0.339 | 18.0% | 100.0% | 100.0% | 231.7 | 0.13 |
| reMem | 84.7% | 0.543 | 30.7% | 100.0% | 100.0% | 231.9 | 0.00 |
| reMem-obs | 81.3% | 0.257 | 3.3% | 100.0% | 100.0% | 231.9 | 0.00 |
| reMem-blend | 82.7% | 0.310 | 5.3% | 100.0% | 100.0% | 231.9 | 0.00 |

## Grounded accuracy by ability

| System | Preference following |
| --- | --- |
| no-memory | 0.0% |
| naive-vector | 18.0% |
| reMem | 30.7% |
| reMem-obs | 3.3% |
| reMem-blend | 5.3% |
