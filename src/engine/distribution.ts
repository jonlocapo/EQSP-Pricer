/**
 * Pure distribution-statistics helpers over a flat array of per-sample PV%
 * outcomes (one float per path, or per antithetic pair — whatever unit
 * Aggregator.addSample was fed). Kept free of MC/worker types so they're
 * testable with hand-built literal arrays.
 */

export interface Histogram {
  /** Bin boundaries, length nBins + 1, ascending, in pvPct units. */
  binEdges: number[];
  /** Bin counts, length nBins, counts[i] = # samples in [binEdges[i], binEdges[i+1]). */
  counts: number[];
}

const DEFAULT_BINS = 24;

/** Evenly-spaced histogram spanning [min(samples), max(samples)]. */
export function computeHistogram(samples: number[], nBins = DEFAULT_BINS): Histogram {
  if (samples.length === 0) return { binEdges: [], counts: [] };
  let min = samples[0];
  let max = samples[0];
  for (const s of samples) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  if (min === max) {
    // Degenerate (all samples identical): center a unit-wide range so bins
    // are well-defined rather than dividing by zero.
    min -= 0.5;
    max += 0.5;
  }
  const width = (max - min) / nBins;
  const binEdges: number[] = [];
  for (let i = 0; i <= nBins; i++) binEdges.push(min + width * i);
  const counts = new Array(nBins).fill(0);
  for (const s of samples) {
    let idx = Math.floor((s - min) / width);
    if (idx >= nBins) idx = nBins - 1;
    if (idx < 0) idx = 0;
    counts[idx] += 1;
  }
  return { binEdges, counts };
}

/** P(sample < referenceLevelPct), as a fraction in [0, 1]. */
export function computePLoss(samples: number[], referenceLevelPct: number): number {
  if (samples.length === 0) return 0;
  let n = 0;
  for (const s of samples) if (s < referenceLevelPct) n += 1;
  return n / samples.length;
}

/**
 * Mean of the worst `alpha` fraction of samples (e.g. alpha = 0.05 for
 * Expected Shortfall at the 5% level). At least one sample is always
 * included so ES is well-defined even for tiny sample sets.
 */
export function computeExpectedShortfall(samples: number[], alpha: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const n = Math.max(1, Math.round(sorted.length * alpha));
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i];
  return sum / n;
}
