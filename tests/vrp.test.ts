import { describe, expect, it } from 'vitest';
import {
  MAX_RATIO,
  MIN_RATIO,
  applyVrp,
  nearestAnchorTerm,
  scaleTermStructure,
  vrpRatio,
} from '../src/model/vrp';
import type { RealizedMoments } from '../src/model/realizedSurface';

/**
 * Pure tests for the volatility-risk-premium layer — no network. These pin
 * the two properties the whole ladder depends on: the ratio never scales a
 * surface DOWN (clamped at 1), never blows up an outlier reading past the
 * cap, and a premium moves the LEVEL of a term structure without touching
 * skew or kurtosis (the shape).
 */

describe('vrpRatio', () => {
  it('returns the raw implied/realized ratio inside the band', () => {
    expect(vrpRatio(0.20, 0.16)).toBeCloseTo(1.25, 10);
  });

  it('clamps to MIN_RATIO when realized exceeds implied (a crash-like reading)', () => {
    // Implied below realized would produce a ratio < 1, which must never be
    // used to scale a surface DOWN — clamp to "apply no premium".
    expect(vrpRatio(0.15, 0.30)).toBe(MIN_RATIO);
    expect(vrpRatio(0.15, 0.30)).toBe(1);
  });

  it('clamps to MAX_RATIO for an extreme spike', () => {
    expect(vrpRatio(0.60, 0.10)).toBe(MAX_RATIO);
  });

  it('honors custom min/max overrides', () => {
    expect(vrpRatio(0.20, 0.16, { minRatio: 1.1, maxRatio: 1.2 })).toBe(1.2);
    expect(vrpRatio(0.05, 0.16, { minRatio: 1.1, maxRatio: 1.2 })).toBe(1.1);
  });

  it('degrades non-finite or non-positive inputs to "no premium" rather than NaN', () => {
    expect(vrpRatio(NaN, 0.16)).toBe(MIN_RATIO);
    expect(vrpRatio(0.2, 0)).toBe(MIN_RATIO);
    expect(vrpRatio(0.2, -0.1)).toBe(MIN_RATIO);
    expect(vrpRatio(Infinity, 0.16)).toBe(MIN_RATIO);
  });
});

describe('scaleTermStructure', () => {
  it('multiplies every term vol by the ratio, and leaves maturities untouched', () => {
    const terms = [
      { tYears: 21 / 252, vol: 0.2 },
      { tYears: 63 / 252, vol: 0.22 },
      { tYears: 252 / 252, vol: 0.25 },
    ];
    const scaled = scaleTermStructure(terms, 1.2);
    expect(scaled).toEqual([
      { tYears: 21 / 252, vol: 0.24 },
      { tYears: 63 / 252, vol: 0.264 },
      { tYears: 252 / 252, vol: 0.3 },
    ]);
    // The original array is not mutated.
    expect(terms[0].vol).toBe(0.2);
  });

  it('is a no-op at ratio 1', () => {
    const terms = [{ tYears: 1, vol: 0.3 }];
    expect(scaleTermStructure(terms, 1)).toEqual(terms);
  });
});

describe('applyVrp', () => {
  it('scales terms but leaves skew and excess kurtosis exactly alone', () => {
    const moments: RealizedMoments = {
      terms: [
        { tYears: 21 / 252, vol: 0.18 },
        { tYears: 252 / 252, vol: 0.22 },
      ],
      skewDaily: -0.42,
      excessKurtDaily: 1.7,
    };
    const scaled = applyVrp(moments, 1.3);
    expect(scaled.terms[0].vol).toBeCloseTo(0.234, 10);
    expect(scaled.terms[1].vol).toBeCloseTo(0.286, 10);
    // A risk premium moves the level, not the shape.
    expect(scaled.skewDaily).toBe(moments.skewDaily);
    expect(scaled.excessKurtDaily).toBe(moments.excessKurtDaily);
  });
});

describe('nearestAnchorTerm', () => {
  it('picks the term closest to the default ~30-day anchor (21 trading days)', () => {
    const terms = [
      { tYears: 21 / 252, vol: 0.18 },
      { tYears: 63 / 252, vol: 0.2 },
      { tYears: 252 / 252, vol: 0.24 },
    ];
    expect(nearestAnchorTerm(terms)).toEqual(terms[0]);
  });

  it('picks the closest term to an explicit target when several are offered', () => {
    const terms = [
      { tYears: 21 / 252, vol: 0.18 },
      { tYears: 63 / 252, vol: 0.2 },
      { tYears: 126 / 252, vol: 0.22 },
    ];
    // Target near the 63-day window should pick that one, not the 21-day.
    expect(nearestAnchorTerm(terms, 60 / 252)).toEqual(terms[1]);
  });

  it('throws on an empty term structure rather than picking a phantom term', () => {
    expect(() => nearestAnchorTerm([])).toThrow();
  });
});
