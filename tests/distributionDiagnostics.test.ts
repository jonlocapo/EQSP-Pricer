import { describe, expect, it } from 'vitest';
import { computeExpectedShortfall, computeHistogram, computePLoss } from '../src/engine/distribution';

// samples = 51, 52, ..., 150 (100 evenly-spaced values, step 1).
const samples = Array.from({ length: 100 }, (_, i) => 51 + i);

describe('computePLoss', () => {
  it('counts samples strictly below the reference level, hand-computed', () => {
    // Values < 100: 51..99 inclusive = 49 values out of 100.
    expect(computePLoss(samples, 100)).toBeCloseTo(0.49, 12);
  });

  it('is 0 when the reference level is below every sample', () => {
    expect(computePLoss(samples, 0)).toBe(0);
  });

  it('is 1 when the reference level is above every sample', () => {
    expect(computePLoss(samples, 1000)).toBe(1);
  });

  it('returns 0 for an empty sample set', () => {
    expect(computePLoss([], 100)).toBe(0);
  });
});

describe('computeExpectedShortfall', () => {
  it('ES5%: mean of the worst 5 of 100 samples (51..55) = 53', () => {
    // n = round(100 * 0.05) = 5; worst 5 sorted values: 51,52,53,54,55.
    expect(computeExpectedShortfall(samples, 0.05)).toBeCloseTo(53, 12);
  });

  it('ES1%: mean of the worst 1 of 100 samples (51) = 51', () => {
    // n = round(100 * 0.01) = 1; worst 1 sorted value: 51.
    expect(computeExpectedShortfall(samples, 0.01)).toBeCloseTo(51, 12);
  });

  it('does not mutate the input array (sorts a copy)', () => {
    const copy = [...samples];
    computeExpectedShortfall(samples, 0.05);
    expect(samples).toEqual(copy);
  });

  it('always includes at least one sample, even for alpha rounding to 0', () => {
    // With only 3 samples, alpha=0.01 rounds to 0 pre-floor; the function
    // must still return the single worst sample rather than NaN/0-div.
    expect(computeExpectedShortfall([10, 20, 30], 0.01)).toBe(10);
  });

  it('returns 0 for an empty sample set', () => {
    expect(computeExpectedShortfall([], 0.05)).toBe(0);
  });
});

describe('computeHistogram', () => {
  it('bins 100 evenly-spaced samples [51,150] into 24 equal-width bins spanning the sample range', () => {
    const { binEdges, counts } = computeHistogram(samples, 24);
    expect(binEdges.length).toBe(25);
    expect(binEdges[0]).toBeCloseTo(51, 12);
    expect(binEdges[24]).toBeCloseTo(150, 12);
    expect(counts.length).toBe(24);
    // Every sample must land in exactly one bin.
    expect(counts.reduce((a, b) => a + b, 0)).toBe(100);
    // No bin should be empty for a dense, evenly-spaced input.
    expect(counts.every((c) => c > 0)).toBe(true);
  });

  it('handles a degenerate all-identical sample set without dividing by zero', () => {
    const { binEdges, counts } = computeHistogram([42, 42, 42, 42], 24);
    expect(binEdges.length).toBe(25);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(4);
    expect(Number.isFinite(binEdges[0])).toBe(true);
    expect(Number.isFinite(binEdges[24])).toBe(true);
  });

  it('returns empty edges/counts for an empty sample set', () => {
    expect(computeHistogram([])).toEqual({ binEdges: [], counts: [] });
  });
});
