import { wilsonInterval } from "./stats.js";
import type { DensityQuestion, DensityReport } from "./types.js";

// factconsolidation presents serial-numbered natural-language facts, where a
// larger serial supersedes a smaller one asserting a different value for the
// same thing. That makes density computable exactly, with no model in the loop,
// which is why this benchmark anchors the LLM classifier used on LoCoMo and
// PrefEval.
export interface SerialFact {
  serial: number;
  text: string;
}

const FACT_LINE = /^\s*(\d+)\.\s*(.+?)\s*$/;

export function parseSerialFacts(context: string): SerialFact[] {
  const out: SerialFact[] = [];
  for (const line of context.split("\n")) {
    const m = FACT_LINE.exec(line);
    if (!m) continue;
    out.push({ serial: Number(m[1]!), text: m[2]! });
  }
  return out;
}

// Lowercase and drop a single trailing full stop, so that a fact sentence and a
// gold answer can be compared without punctuation or casing getting in the way.
function normalise(s: string): string {
  return s.trim().replace(/\.$/, "").toLowerCase();
}

// The sentence prefix left once a trailing value is removed, or null when the
// sentence does not end with that value. The prefix is the unit of comparison:
// two facts contradict when they share a prefix and differ after it.
export function prefixFor(text: string, value: string): string | null {
  const t = normalise(text);
  const v = normalise(value);
  if (v === "") return null;
  if (!t.endsWith(v)) return null;
  const prefix = t.slice(0, t.length - v.length);
  if (prefix === "") return null;
  return prefix;
}

export function exactDensity(
  questions: DensityQuestion[],
  facts: SerialFact[],
  benchmark: string,
): DensityReport {
  const normalised = facts.map((f) => normalise(f.text));

  let contradictions = 0;
  let unscoreable = 0;

  for (const question of questions) {
    // Which sentence prefixes end with this question's gold answer? Usually
    // exactly one. More than one means the answer is the tail of two different
    // statements, and any contested one is enough to make the question a
    // contradiction case.
    const prefixes = new Set<string>();
    for (const f of facts) {
      const p = prefixFor(f.text, question.goldAnswer);
      if (p !== null) prefixes.add(p);
    }

    if (prefixes.size === 0) {
      // The gold answer appears nowhere as the tail of a fact, so this question
      // cannot be scored by this method. Counting it as a non-contradiction
      // would understate density silently, so it is reported instead.
      unscoreable++;
      continue;
    }

    let contested = false;
    for (const prefix of prefixes) {
      const endings = new Set<string>();
      for (const t of normalised) {
        if (t.startsWith(prefix)) endings.add(t.slice(prefix.length));
      }
      if (endings.size > 1) {
        contested = true;
        break;
      }
    }
    if (contested) contradictions++;
  }

  const n = questions.length;
  return {
    benchmark,
    n,
    contradictions,
    density: n === 0 ? 0 : contradictions / n,
    ci95: wilsonInterval(contradictions, n),
    failures: unscoreable,
  };
}
