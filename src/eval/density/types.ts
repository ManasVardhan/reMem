// A question is classified as requiring contradiction resolution when the
// context holds two or more assertions about the same (entity, predicate) pair
// with different values, and the gold answer is the temporally later one.
//
// Nothing in this definition references reMem. That is deliberate: the whole
// argument depends on density being a property of the benchmark rather than of
// any system measured on it.
export type DensityLabel = "contradiction" | "no-contradiction";

export interface DensityQuestion {
  id: string;
  benchmark: string;
  question: string;
  goldAnswer: string;
  // The assertions the classifier may inspect. For LoCoMo these are the gold
  // evidence turns the dataset already annotates, not the whole conversation:
  // that cuts cost by orders of magnitude and raises precision.
  context: string[];
}

export interface DensityVerdict {
  id: string;
  label: DensityLabel;
  // The two conflicting assertions, verbatim from context. Empty when the label
  // is "no-contradiction". Requiring the pair is the anti-hallucination device:
  // a bare yes/no invites the model to guess yes.
  evidence: string[];
  // True when the classifier call itself failed, for example on a rate limit or
  // an auth error. Such a verdict still carries the conservative
  // no-contradiction label, which is indistinguishable from a genuine negative,
  // so this flag is the only thing preventing a half-failed sweep from silently
  // depressing the measured density.
  failed: boolean;
}

export interface DensityReport {
  benchmark: string;
  n: number;
  contradictions: number;
  density: number;
  ci95: [number, number];
  // Questions that could not be scored: a classifier call that failed, or a
  // gold answer the exact method could not locate. Any value above zero means
  // the density above is an underestimate and the run should not be reported.
  failures: number;
}
