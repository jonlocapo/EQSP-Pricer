import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BETA_1Y,
  SINGLE_NAME_SKEW_DAMPING,
  buildSkewSurface,
  effectiveBeta1y,
} from '../src/model/skewSurface';
import { volAtPctOfSpot } from '../src/model/volSurface';

/**
 * Pure tests for the slope-parameterised skew surface, no network. These pin
 * the properties the wiring in volPipeline.ts depends on: the term structure
 * decays the way the empirical stylised fact says it should, the smile
 * never inverts, a single name gets a shallower wing than an index, and the
 * backstop clamp is not doing the actual work in the normal strike band.
 */

const ATM = 0.2;
const RATE = 0;
const DIV = 0;
const SPOT = 100;

/** Reference reimplementation of the parameterisation, independent of
 * buildSkewSurface's own strike loop, so the test does not just check that
 * the code agrees with itself. Forward equals spot here (rate = div = 0). */
function premiumAt80Pct(tYears: number, beta1y: number, atmVol = ATM): number {
  const k = Math.log(0.8); // ln(K / F), F = spot at zero rate and div
  const beta = beta1y / Math.sqrt(tYears);
  const gamma = beta / 2;
  const iv = atmVol * (1 + beta * -k + gamma * k * k);
  return (iv - atmVol) * 100; // vol points
}

describe('DEFAULT_BETA_1Y term structure', () => {
  /**
   * The 80%-strike premium at each tenor, on a 20% ATM vol, using the
   * documented default calibration. These are the illustrative reference
   * values from the calibration exercise that produced DEFAULT_BETA_1Y
   * (0.2268 * (139.55 - 100) / 10). That exercise used a small-moneyness
   * linear approximation of ln(K / F); this module uses the exact log, per
   * spec, so the two differ by a small, CONSTANT relative amount, roughly
   * 11% at the 80% strike, across every tenor (they scale together, so the
   * ratio is the same regardless of tenor). 18% relative tolerance absorbs
   * that gap while still catching a materially wrong calibration or term
   * structure.
   */
  const targets: [number, number][] = [
    [1 / 12, 13.9],
    [1 / 4, 8.0],
    [1 / 2, 5.7],
    [1, 4.0],
    [3, 2.3],
    [5, 1.8],
  ];

  it.each(targets)('is within 18%% of the reference value at T=%p years', (tYears, target) => {
    const premium = premiumAt80Pct(tYears, DEFAULT_BETA_1Y);
    expect(premium).toBeGreaterThan(target * 0.82);
    expect(premium).toBeLessThan(target * 1.18);
  });

  it('decays close to the empirical 1/sqrt(T) rule, not 1/T', () => {
    const p1m = premiumAt80Pct(1 / 12, DEFAULT_BETA_1Y);
    const p1y = premiumAt80Pct(1, DEFAULT_BETA_1Y);
    // 1/sqrt(T) predicts p1m / p1y = sqrt(12) ~= 3.46. 1/T would predict 12.
    expect(p1m / p1y).toBeCloseTo(Math.sqrt(12), 1);
  });

  it('matches buildSkewSurface itself at the 80% strike, every tenor', () => {
    const terms = targets.map(([tYears]) => ({ tYears, vol: ATM }));
    const surface = buildSkewSurface(SPOT, terms, DEFAULT_BETA_1Y, RATE, DIV, 'test');
    for (const slice of surface.slices) {
      const pt = slice.points.find((p) => p.strike === 80);
      expect(pt).toBeDefined();
      const expected = ATM + premiumAt80Pct(slice.tYears, DEFAULT_BETA_1Y) / 100;
      expect(pt!.iv).toBeCloseTo(expected, 9);
    }
  });
});

describe('monotonicity in beta1y', () => {
  it('a steeper beta1y gives a steeper wing at every tenor', () => {
    const tenors = [1 / 12, 1 / 4, 1, 3, 5];
    for (const tYears of tenors) {
      const low = premiumAt80Pct(tYears, 0.4);
      const high = premiumAt80Pct(tYears, 0.9);
      expect(high).toBeGreaterThan(low);
    }
  });

  it('beta1y = 0 gives no premium at all, at any strike', () => {
    const terms = [{ tYears: 1, vol: ATM }];
    const surface = buildSkewSurface(SPOT, terms, 0, RATE, DIV, 'test');
    expect(surface.isFlat).toBe(true);
    for (const pt of surface.slices[0].points) {
      expect(pt.iv).toBeCloseTo(ATM, 12);
    }
  });
});

describe('smile shape', () => {
  it('is monotone decreasing in strike from 60% to 140%, at 1y and 5y', () => {
    const terms = [
      { tYears: 1, vol: ATM },
      { tYears: 5, vol: ATM },
    ];
    const surface = buildSkewSurface(SPOT, terms, DEFAULT_BETA_1Y, RATE, DIV, 'test');
    for (const slice of surface.slices) {
      const band = slice.points.filter((p) => p.strike >= 60 && p.strike <= 140);
      for (let i = 1; i < band.length; i++) {
        expect(band[i].iv).toBeLessThan(band[i - 1].iv);
      }
    }
  });

  it('does not hit the realizedSurface clamp band anywhere in 60%-140%, at 1y or longer', () => {
    // MIN_REL/MAX_REL/MIN_ABS/MAX_ABS from ../src/model/realizedSurface.ts:
    // 0.4x-2.5x the term's own ATM vol, and an absolute 1%-200% band. A
    // clamp binding here would mean the parameterisation itself is wrong,
    // not that the backstop is doing its job.
    const terms = [
      { tYears: 1, vol: ATM },
      { tYears: 3, vol: ATM },
      { tYears: 5, vol: ATM },
    ];
    const surface = buildSkewSurface(SPOT, terms, DEFAULT_BETA_1Y, RATE, DIV, 'test');
    for (const slice of surface.slices) {
      for (const pt of slice.points) {
        if (pt.strike < 60 || pt.strike > 140) continue;
        expect(pt.iv).toBeGreaterThan(ATM * 0.4);
        expect(pt.iv).toBeLessThan(ATM * 2.5);
        expect(pt.iv).toBeGreaterThan(0.01);
        expect(pt.iv).toBeLessThan(2.0);
      }
    }
  });

  it('reproduces the validated upside wing at 1y: 110% ~18.4%, 140% ~15.0%', () => {
    const terms = [{ tYears: 1, vol: ATM }];
    const surface = buildSkewSurface(SPOT, terms, DEFAULT_BETA_1Y, RATE, DIV, 'test');
    const at110 = volAtPctOfSpot(surface, 110, 1);
    const at140 = volAtPctOfSpot(surface, 140, 1);
    expect(at110).toBeCloseTo(0.184, 2);
    expect(at140).toBeCloseTo(0.15, 2);
  });
});

describe('effectiveBeta1y', () => {
  it('floors a negative beta1y at zero, so the smile can never invert', () => {
    expect(effectiveBeta1y(true, -0.5)).toBe(0);
    expect(effectiveBeta1y(false, -0.5)).toBe(0);
  });

  it('damps a single name below an index at the same beta1y', () => {
    const index = effectiveBeta1y(true, DEFAULT_BETA_1Y);
    const single = effectiveBeta1y(false, DEFAULT_BETA_1Y);
    expect(single).toBeLessThan(index);
    expect(single).toBeCloseTo(index * SINGLE_NAME_SKEW_DAMPING, 12);
  });

  it('a single name gets a shallower wing than an index at the same input level', () => {
    const terms = [{ tYears: 1, vol: ATM }];
    const indexBeta = effectiveBeta1y(true, DEFAULT_BETA_1Y);
    const singleBeta = effectiveBeta1y(false, DEFAULT_BETA_1Y);
    const indexSurface = buildSkewSurface(SPOT, terms, indexBeta, RATE, DIV, 'index');
    const singleSurface = buildSkewSurface(SPOT, terms, singleBeta, RATE, DIV, 'single');
    const indexAt80 = volAtPctOfSpot(indexSurface, 80, 1);
    const singleAt80 = volAtPctOfSpot(singleSurface, 80, 1);
    expect(singleAt80).toBeLessThan(indexAt80);
    expect(singleAt80).toBeGreaterThan(ATM); // still a real, positive wing
  });

  it('defaults to DEFAULT_BETA_1Y when no beta1y is passed', () => {
    expect(effectiveBeta1y(true)).toBe(DEFAULT_BETA_1Y);
  });
});
