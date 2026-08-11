import { describe, expect, it } from 'vitest';
import {
  allowedFrequencies,
  coerceFrequency,
  isFrequencyAllowed,
  MONTHS_PER_PERIOD,
  tenorMonths,
} from '../src/model/product';
import type { Frequency } from '../src/model/product';
import { buildGrid } from '../src/engine/schedule';
import { validateCoupon } from '../src/services/validation';
import type { CouponProductSpec } from '../src/model/product';
import type { MarketData } from '../src/model/market';

/**
 * A note's tenor is always a whole number of its coupon periods. An 18-month
 * note pays semiannually, quarterly or monthly, never annually, because the
 * second annual date would fall six months after it has matured.
 *
 * This was not enforced, and the failure was silent rather than loud. See
 * `isFrequencyAllowed` for the measurement: an 18-month 8% conditional coupon
 * paid one coupon instead of one and a half, and priced BELOW both its 1-year
 * and 2-year neighbours.
 */

const FREQS: Frequency[] = ['monthly', 'quarterly', 'semiannual', 'annual'];

describe('a frequency is allowed only when its period divides the tenor', () => {
  it('accepts the combinations a desk actually writes', () => {
    expect(isFrequencyAllowed(1, 'annual')).toBe(true);
    expect(isFrequencyAllowed(1.5, 'semiannual')).toBe(true);
    expect(isFrequencyAllowed(1.5, 'quarterly')).toBe(true);
    expect(isFrequencyAllowed(0.25, 'quarterly')).toBe(true);
    expect(isFrequencyAllowed(5, 'annual')).toBe(true);
  });

  it('refuses the combinations that put an observation after maturity', () => {
    // 18 months is not two years.
    expect(isFrequencyAllowed(1.5, 'annual')).toBe(false);
    // 30 months is not three years.
    expect(isFrequencyAllowed(2.5, 'annual')).toBe(false);
    // 9 months is not two half-years.
    expect(isFrequencyAllowed(0.75, 'semiannual')).toBe(false);
    expect(isFrequencyAllowed(0.75, 'annual')).toBe(false);
  });

  it('refuses a tenor that is not a whole number of months at all', () => {
    // 1.1 years is 13.2 months. No period divides it, monthly included.
    expect(tenorMonths(1.1)).toBeNull();
    for (const f of FREQS) expect(isFrequencyAllowed(1.1, f)).toBe(false);
    expect(allowedFrequencies(1.1)).toEqual([]);
  });

  it('survives the float arithmetic of a tenor typed in years', () => {
    // 1.5 * 12 is exactly 18, but these must not depend on that luck.
    expect(tenorMonths(1.5)).toBe(18);
    expect(tenorMonths(0.25)).toBe(3);
    expect(tenorMonths(1 / 12)).toBe(1);
    expect(isFrequencyAllowed(1 / 12, 'monthly')).toBe(true);
    expect(isFrequencyAllowed(7 / 12, 'monthly')).toBe(true);
    expect(isFrequencyAllowed(7 / 12, 'quarterly')).toBe(false);
  });

  it('lists the allowed periods longest first', () => {
    expect(allowedFrequencies(2)).toEqual(['annual', 'semiannual', 'quarterly', 'monthly']);
    expect(allowedFrequencies(1.5)).toEqual(['semiannual', 'quarterly', 'monthly']);
    expect(allowedFrequencies(0.75)).toEqual(['quarterly', 'monthly']);
  });
});

describe('a tenor edit snaps a stranded frequency instead of leaving it illegal', () => {
  it('keeps a frequency the new tenor still allows', () => {
    expect(coerceFrequency(1.5, 'quarterly')).toBe('quarterly');
    expect(coerceFrequency(2, 'annual')).toBe('annual');
  });

  it('steps down to the longest period that fits, not the shortest', () => {
    // 2y annual edited to 18 months becomes semiannual, not monthly.
    expect(coerceFrequency(1.5, 'annual')).toBe('semiannual');
    // 9 months cannot take a half-year, so it lands on quarterly.
    expect(coerceFrequency(0.75, 'semiannual')).toBe('quarterly');
    expect(coerceFrequency(0.75, 'annual')).toBe('quarterly');
  });

  it('never returns a frequency the tenor disallows', () => {
    for (const months of [1, 2, 3, 4, 6, 9, 12, 18, 24, 30, 36, 60]) {
      for (const f of FREQS) {
        const tenor = months / 12;
        expect(isFrequencyAllowed(tenor, coerceFrequency(tenor, f))).toBe(true);
      }
    }
  });
});

const market: MarketData = { spot: 100, vol: 0.25, rate: 0.03, divYield: 0.02, currency: 'EUR' };

function couponSpec(tenorYears: number, frequency: Frequency): CouponProductSpec {
  return {
    kind: 'coupon',
    underlyings: [{ name: 'A' }],
    notional: 1_000_000,
    tenorYears,
    reofferPct: 100,
    issuePricePct: 100,
    barrierType: 'european',
    kiBarrierPct: 60,
    putStrikePct: 100,
    downsideLeveragePct: 100,
    callType: 'constant',
    callFrequency: frequency,
    callFromPeriod: 1,
    callBarrierPct: 100,
    stepDownPct: 0,
    customCallBarriersPct: [],
    couponType: 'conditional',
    couponFrequency: frequency,
    couponBarrierPct: 60,
    couponPaPct: 8,
    acCouponType: 'none',
    acCouponPct: 0,
  };
}

describe('validation refuses what the pickers grey out', () => {
  it('rejects an 18-month note with annual coupons', () => {
    const r = validateCoupon(couponSpec(1.5, 'annual'), market);
    expect(r.valid).toBe(false);
    expect(r.errors.couponFrequency).toBeDefined();
    expect(r.errors.callFrequency).toBeDefined();
  });

  it('accepts the same note paying semiannually', () => {
    const r = validateCoupon(couponSpec(1.5, 'semiannual'), market);
    expect(r.errors.couponFrequency).toBeUndefined();
    expect(r.errors.callFrequency).toBeUndefined();
    expect(r.valid).toBe(true);
  });
});

describe('every allowed combination builds a sound grid', () => {
  /**
   * This is the property the rule exists to protect. A refused combination
   * produced a duplicated final grid time, a zero-length last step, and a HOLE
   * in the observation arrays, which is how the coupon went missing.
   */
  it('gives strictly increasing times, no holes, and one observation per period', () => {
    for (const months of [3, 6, 9, 12, 18, 24, 30, 36, 60]) {
      const tenor = months / 12;
      for (const frequency of allowedFrequencies(tenor)) {
        const grid = buildGrid(couponSpec(tenor, frequency));
        const times = Array.from(grid.times);
        const where = `${months}m ${frequency}`;

        // Strictly increasing: no zero-length step.
        for (let i = 1; i < times.length; i++) {
          expect(times[i], `${where} times not increasing at ${i}`).toBeGreaterThan(times[i - 1]);
        }
        // Ends exactly at maturity, and never runs past it.
        expect(times[times.length - 1], where).toBeCloseTo(tenor, 9);

        // No holes, and exactly one observation per period.
        const expectedObs = months / MONTHS_PER_PERIOD[frequency];
        for (const obs of [grid.couponObs, grid.callObs]) {
          expect(obs.length, `${where} observation count`).toBe(expectedObs);
          for (const idx of obs) {
            expect(Number.isInteger(idx), `${where} hole in observations`).toBe(true);
            expect(idx).toBeGreaterThan(0);
            expect(idx).toBeLessThanOrEqual(grid.nSteps);
          }
        }
      }
    }
  });
});
