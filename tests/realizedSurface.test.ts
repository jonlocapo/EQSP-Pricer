import { describe, expect, it } from 'vitest';
import {
  buildRealizedSurface,
  dailyReturnMoments,
  realizedTermStructure,
} from '../src/model/realizedSurface';
import { skewPoints, volAtPctOfSpot } from '../src/model/volSurface';

/**
 * The realized surface exists because option chains cannot be fetched
 * dependably in the browser. These tests pin the properties that make it
 * usable: the moments are measured correctly, and NEGATIVE return skewness
 * produces a downward-sloping smile (higher vol at low strikes) — the same
 * direction a real equity surface has, which is what the barrier legs need.
 */

/** Deterministic pseudo-normal sample, so tests never depend on Math.random. */
function pseudoNormals(n: number, seed = 12345): number[] {
  let a = seed;
  const u = () => {
    a = (a * 1664525 + 1013904223) % 4294967296;
    return (a + 0.5) / 4294967296;
  };
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt(-2 * Math.log(u()));
    out.push(r * Math.cos(2 * Math.PI * u()));
  }
  return out;
}

describe('dailyReturnMoments', () => {
  it('recovers vol, and reports ~zero skew/excess kurtosis for a symmetric sample', () => {
    const z = pseudoNormals(4000);
    const sd = 0.01;
    const { volDaily, skewDaily, excessKurtDaily } = dailyReturnMoments(z.map((x) => x * sd));
    expect(volDaily).toBeCloseTo(sd, 3);
    expect(Math.abs(skewDaily)).toBeLessThan(0.15);
    expect(Math.abs(excessKurtDaily)).toBeLessThan(0.3);
  });

  it('detects negative skewness when large moves are to the downside', () => {
    const z = pseudoNormals(3000).map((x) => x * 0.01);
    // Add occasional sharp drops — the equity pattern.
    for (let i = 0; i < z.length; i += 97) z[i] = -0.06;
    const { skewDaily } = dailyReturnMoments(z);
    expect(skewDaily).toBeLessThan(-0.5);
  });

  it('is safe on a degenerate series', () => {
    expect(dailyReturnMoments([]).volDaily).toBe(0);
    expect(dailyReturnMoments([0, 0, 0, 0]).skewDaily).toBe(0);
  });
});

describe('realizedTermStructure', () => {
  it('produces one annualized vol per window that the history supports', () => {
    const r = pseudoNormals(300).map((x) => x * 0.01);
    const terms = realizedTermStructure(r);
    expect(terms.length).toBeGreaterThan(1);
    // Ascending maturities, all plausibly ~0.01*sqrt(252) ≈ 16%.
    for (let i = 1; i < terms.length; i++) expect(terms[i].tYears).toBeGreaterThan(terms[i - 1].tYears);
    for (const t of terms) expect(t.vol).toBeGreaterThan(0.05);
  });

  it('skips windows longer than the available history', () => {
    const r = pseudoNormals(40).map((x) => x * 0.01);
    const terms = realizedTermStructure(r);
    // 40 days cannot support the 252-day window.
    expect(terms.every((t) => t.tYears < 1)).toBe(true);
  });
});

describe('buildRealizedSurface', () => {
  const spot = 100;

  it('anchors the ATM vol to the measured realized vol', () => {
    const s = buildRealizedSurface(
      spot,
      { terms: [{ tYears: 1, vol: 0.2 }], skewDaily: -0.5, excessKurtDaily: 3 },
      'test',
    );
    expect(volAtPctOfSpot(s, 100, 1)).toBeCloseTo(0.2, 6);
  });

  it('turns NEGATIVE return skewness into a downward-sloping smile', () => {
    const s = buildRealizedSurface(
      spot,
      { terms: [{ tYears: 1, vol: 0.2 }], skewDaily: -1.2, excessKurtDaily: 4 },
      'test',
    );
    // Low strikes must carry MORE vol than ATM — the equity skew these
    // products' knock-in legs actually live on.
    expect(volAtPctOfSpot(s, 70, 1)).toBeGreaterThan(volAtPctOfSpot(s, 100, 1));
    expect(volAtPctOfSpot(s, 130, 1)).toBeLessThan(volAtPctOfSpot(s, 100, 1));
    expect(skewPoints(s, 1, 80)).toBeGreaterThan(0);
  });

  it('produces a flat smile when returns are symmetric and Gaussian', () => {
    const s = buildRealizedSurface(
      spot,
      { terms: [{ tYears: 1, vol: 0.2 }], skewDaily: 0, excessKurtDaily: 0 },
      'test',
    );
    expect(volAtPctOfSpot(s, 60, 1)).toBeCloseTo(0.2, 6);
    expect(volAtPctOfSpot(s, 140, 1)).toBeCloseTo(0.2, 6);
  });

  it('flattens the smile as maturity lengthens, as real surfaces do', () => {
    const moments = { skewDaily: -1.0, excessKurtDaily: 4 };
    const s = buildRealizedSurface(
      spot,
      { terms: [{ tYears: 0.25, vol: 0.2 }, { tYears: 1, vol: 0.2 }], ...moments },
      'test',
    );
    // Daily skewness aggregates as 1/sqrt(n), so the 1y smile is shallower.
    expect(skewPoints(s, 0.25, 80)).toBeGreaterThan(skewPoints(s, 1, 80));
  });

  it('clamps wings instead of letting a fat-tailed sample produce nonsense', () => {
    const s = buildRealizedSurface(
      spot,
      { terms: [{ tYears: 1, vol: 0.2 }], skewDaily: -20, excessKurtDaily: 200 },
      'test',
    );
    for (const p of s.slices[0].points) {
      expect(p.iv).toBeGreaterThan(0);
      expect(p.iv).toBeLessThanOrEqual(0.2 * 2.5 + 1e-12);
    }
  });

  it('refuses to build without a spot or any term', () => {
    expect(() => buildRealizedSurface(0, { terms: [{ tYears: 1, vol: 0.2 }], skewDaily: 0, excessKurtDaily: 0 }, 't')).toThrow(
      /positive spot/i,
    );
    expect(() => buildRealizedSurface(spot, { terms: [], skewDaily: 0, excessKurtDaily: 0 }, 't')).toThrow(
      /not enough price history/i,
    );
  });
});
