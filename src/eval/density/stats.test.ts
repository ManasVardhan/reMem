import { describe, expect, it } from "vitest";
import { cohensKappa, wilsonInterval } from "./stats.js";

describe("wilsonInterval", () => {
  it("brackets the point estimate", () => {
    const [lo, hi] = wilsonInterval(45, 100);
    expect(lo).toBeGreaterThan(0.35);
    expect(lo).toBeLessThan(0.45);
    expect(hi).toBeGreaterThan(0.45);
    expect(hi).toBeLessThan(0.56);
  });

  it("stays inside [0,1] at the boundaries", () => {
    const [lo, hi] = wilsonInterval(0, 20);
    expect(lo).toBe(0);
    expect(hi).toBeGreaterThan(0);
    expect(hi).toBeLessThan(1);
  });

  it("returns [0,0] for an empty sample", () => {
    expect(wilsonInterval(0, 0)).toEqual([0, 0]);
  });
});

describe("cohensKappa", () => {
  it("is 1 for perfect agreement", () => {
    expect(cohensKappa(["a", "b", "a"], ["a", "b", "a"])).toBeCloseTo(1, 10);
  });

  it("is 0 for chance-level agreement", () => {
    const a = ["a", "a", "b", "b"];
    const b = ["a", "b", "a", "b"];
    expect(cohensKappa(a, b)).toBeCloseTo(0, 10);
  });

  it("is negative for systematic disagreement", () => {
    expect(cohensKappa(["a", "a", "b", "b"], ["b", "b", "a", "a"])).toBeLessThan(0);
  });

  it("throws when the label arrays differ in length", () => {
    expect(() => cohensKappa(["a"], ["a", "b"])).toThrow(/same length/);
  });

  it("uses both raters' marginals, not one rater's squared", () => {
    // Deliberately asymmetric marginals: a has 3 "a" and 1 "b", b has 2 and 2.
    // Correct pe = (3/4)(2/4) + (1/4)(2/4) = 0.5, so kappa = (0.75 - 0.5) / 0.5 = 0.5.
    // A pe built from rater A alone would be 0.625, giving kappa = 0.333, so this
    // test discriminates between the two computations.
    expect(cohensKappa(["a", "a", "a", "b"], ["a", "a", "b", "b"])).toBeCloseTo(0.5, 10);
  });
});
