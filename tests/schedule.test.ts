import { describe, expect, it } from 'vitest';
import { buildGrid } from '../src/engine/schedule';
import type { AccumulatorSpec, CouponProductSpec } from '../src/model/product';

function baseCoupon(overrides: Partial<CouponProductSpec>): CouponProductSpec {
  return {
    kind: 'coupon',
    underlyings: [{ name: 'TEST' }],
    currency: 'EUR',
    notional: 1_000_000,
    tenorYears: 1,
    reofferPct: 100,
    issuePricePct: 100,
    barrierType: 'none',
    kiBarrierPct: 60,
    putStrikePct: 100,
    downsideLeveragePct: 100,
    callType: 'none',
    callFrequency: 'quarterly',
    callFromPeriod: 1,
    callBarrierPct: 100,
    stepDownPct: 0,
    customCallBarriersPct: [],
    couponType: 'fixed',
    couponFrequency: 'quarterly',
    couponBarrierPct: 0,
    couponPaPct: 8,
    acCouponType: 'none',
    acCouponPct: 0,
    ...overrides,
  };
}

describe('buildGrid — coupon products (European/none monitoring => COMPACT grid)', () => {
  // barrierType 'none' (this suite's default) never needs a running min, so
  // buildGrid uses the compact grid: one step per actual observation date,
  // not 252/yr. See needsDailyPath in schedule.ts.

  it('1Y quarterly coupon observations land on grid indices [1,2,3,4] at quarter-year times', () => {
    const grid = buildGrid(baseCoupon({ tenorYears: 1, couponFrequency: 'quarterly' }));
    expect(grid.nSteps).toBe(4);
    expect(grid.couponObs).toEqual([1, 2, 3, 4]);
    expect(grid.times).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('6M monthly coupon observations produce 6 obs ending at nSteps', () => {
    const grid = buildGrid(baseCoupon({ tenorYears: 0.5, couponFrequency: 'monthly' }));
    expect(grid.couponObs).toHaveLength(6);
    expect(grid.couponObs[grid.couponObs.length - 1]).toBe(grid.nSteps);
    expect(grid.times[grid.nSteps]).toBe(0.5);
  });

  it('callObs is empty when callType is none', () => {
    const grid = buildGrid(baseCoupon({ callType: 'none' }));
    expect(grid.callObs).toEqual([]);
  });

  it('callObs mirrors the periodic construction when callable, merged into the same compact grid as couponObs', () => {
    const grid = buildGrid(
      baseCoupon({ tenorYears: 1, callType: 'constant', callFrequency: 'quarterly' }),
    );
    expect(grid.callObs).toEqual([1, 2, 3, 4]);
    expect(grid.callObs).toEqual(grid.couponObs);
  });

  it('a merged quarterly-coupon + monthly-call schedule produces a non-uniform compact grid (more steps than either alone)', () => {
    const grid = buildGrid(
      baseCoupon({ tenorYears: 1, couponFrequency: 'quarterly', callType: 'constant', callFrequency: 'monthly' }),
    );
    expect(grid.nSteps).toBe(12); // monthly dates subsume the quarterly ones
    expect(grid.callObs).toHaveLength(12);
    expect(grid.couponObs).toEqual([3, 6, 9, 12]);
    // Non-uniform: stepDt is a real difference between consecutive months,
    // not a single repeated scalar.
    expect(grid.stepDt.length).toBe(12);
  });

  it('dtYears * nSteps equals tenorYears', () => {
    const grid = buildGrid(baseCoupon({ tenorYears: 1.5 }));
    expect(grid.dtYears * grid.nSteps).toBeCloseTo(1.5, 10);
  });

  it('last grid time is always exactly tenorYears', () => {
    const grid = buildGrid(baseCoupon({ tenorYears: 1.5, couponFrequency: 'quarterly' }));
    expect(grid.times[grid.nSteps]).toBe(1.5);
  });
});

describe('buildGrid — American monitoring stays on the DAILY grid (mispricing guard)', () => {
  // A future refactor that accidentally coarsens American barrier
  // monitoring would silently mis-price knock-in probability — pin the
  // daily-grid invariant explicitly.
  it('coupon with barrierType american builds the full 252/yr daily grid', () => {
    const grid = buildGrid(baseCoupon({ tenorYears: 1, barrierType: 'american', couponFrequency: 'quarterly' }));
    expect(grid.nSteps).toBe(Math.round(1 * 252));
    expect(grid.times.length).toBe(grid.nSteps + 1);
    // Coupon observations still land at their real dates, now expressed as
    // daily-grid indices (not 1..4).
    expect(grid.couponObs).toEqual([63, 126, 189, 252]);
  });

  it('coupon with callType issuerCallable (LSMC) stays on the daily grid even with european KI', () => {
    const grid = buildGrid(
      baseCoupon({ tenorYears: 1, barrierType: 'european', callType: 'issuerCallable', couponFrequency: 'quarterly' }),
    );
    expect(grid.nSteps).toBe(252);
  });

  it('european-only monitoring (the default) does NOT build the daily grid', () => {
    const grid = buildGrid(baseCoupon({ tenorYears: 1, barrierType: 'european', couponFrequency: 'quarterly' }));
    expect(grid.nSteps).toBeLessThan(252);
  });
});

describe('buildGrid — accumulator', () => {
  function baseAccumulator(overrides: Partial<AccumulatorSpec>): AccumulatorSpec {
    return {
      kind: 'accumulator',
      direction: 'accumulate',
      underlyings: [{ name: 'TEST' }],
      currency: 'EUR',
      strikePct: 100,
      upfrontPct: 0,
      tenorYears: 0.25,
      settlementFrequency: 'weekly',
      dailyShares: 100,
      koTriggerPct: 110,
      koSettlement: 'ko0',
      gearing: 1,
      guaranteePeriods: 0,
      ...overrides,
    };
  }

  it('3M weekly: last settlementObs equals nSteps', () => {
    const grid = buildGrid(baseAccumulator({ tenorYears: 0.25, settlementFrequency: 'weekly' }));
    expect(grid.settlementObs[grid.settlementObs.length - 1]).toBe(grid.nSteps);
    // Weekly => every 5 steps.
    expect(grid.settlementObs[0]).toBe(5);
  });

  it('monthly settlement uses 21-step spacing', () => {
    const grid = buildGrid(baseAccumulator({ tenorYears: 1, settlementFrequency: 'monthly' }));
    expect(grid.settlementObs[0]).toBe(21);
    expect(grid.settlementObs[grid.settlementObs.length - 1]).toBe(grid.nSteps);
  });

  it('biweekly settlement uses 10-step spacing', () => {
    // STEPS_PER_YEAR = 252, so 3M (0.25y) -> nSteps = round(0.25*252) = 63.
    // settlementSchedule steps by 10 while idx < nSteps: 10,20,30,40,50,60,
    // then the final entry is forced to nSteps (63) regardless of spacing.
    const grid = buildGrid(baseAccumulator({ tenorYears: 0.25, settlementFrequency: 'biweekly' }));
    expect(grid.nSteps).toBe(63);
    expect(grid.settlementObs).toEqual([10, 20, 30, 40, 50, 60, 63]);
  });
});
