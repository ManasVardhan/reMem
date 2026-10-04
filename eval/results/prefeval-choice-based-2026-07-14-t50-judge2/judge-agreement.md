# PrefEval judge-agreement (self-judging robustness)

Form: choice-based. Distractor turns: 50. Instances: 40.
Answerer + judge A: `openai/gpt-4o-mini`. Judge B: `google/gemini-2.5-flash`.
Each answer is generated once and scored by both judges, so any difference
is judge disagreement with zero answer variance.

| System | Follow (judge A) | Follow (judge B) | Label agree | Follow agree | Cohen kappa |
| --- | --- | --- | --- | --- | --- |
| naive-vector | 35.0% (14/40) | 35.0% (14/40) | 77.5% | 90.0% | 0.780 |
| reMem | 55.0% (22/40) | 60.0% (24/40) | 85.0% | 95.0% | 0.898 |

reMem - naive gap under judge A: 20.0pp; under judge B: 25.0pp.
