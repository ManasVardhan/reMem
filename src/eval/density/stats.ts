// Statistics for the contradiction-density measurement. Pure functions, no IO,
// so they stay hermetic and are the one part of the pipeline that needs no
// model at all.

// Wilson score interval. Preferred over the normal approximation because the
// densities we report sit near 0 for LoCoMo and PrefEval, where the normal
// interval runs below zero and looks absurd in a table.
export function wilsonInterval(
  successes: number,
  n: number,
  z = 1.96,
): [number, number] {
  if (n === 0) return [0, 0];
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const lo = (centre - spread) / denom;
  const hi = (centre + spread) / denom;
  return [Math.max(0, lo), Math.min(1, hi)];
}

// Cohen's kappa: agreement corrected for chance. This is the number that makes
// the density measurement citable rather than an assertion, so it is reported
// in the paper even when it is inconvenient.
export function cohensKappa(a: string[], b: string[]): number {
  if (a.length !== b.length) {
    throw new Error("cohensKappa: label arrays must be the same length");
  }
  const n = a.length;
  if (n === 0) return 0;

  let agreed = 0;
  const countsA = new Map<string, number>();
  const countsB = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const aVal = a[i]!;
    const bVal = b[i]!;
    if (aVal === bVal) agreed++;
    countsA.set(aVal, (countsA.get(aVal) ?? 0) + 1);
    countsB.set(bVal, (countsB.get(bVal) ?? 0) + 1);
  }

  const po = agreed / n;
  let pe = 0;
  for (const [label, ca] of countsA) {
    const cb = countsB.get(label) ?? 0;
    pe += (ca / n) * (cb / n);
  }
  if (pe === 1) return 1;
  return (po - pe) / (1 - pe);
}
