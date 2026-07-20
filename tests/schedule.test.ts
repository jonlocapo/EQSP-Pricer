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

describe('buildGrid — coupon products', () => {
  it('1Y quarterly coupon observations land on [63,126,189,252]', () => {
    const grid = buildGrid(baseCoupon({ tenorYears: 1, couponFrequency: 'quarterly' }));
    expect(grid.nSteps).toBe(252);
    expect(grid.couponObs).toEqual([63, 126, 189, 252]);
  });

  it('6M monthly coupon observations produce 6 obs ending at nSteps', () => {
    const grid = buildGrid(baseCoupon({ tenorYears: 0.5, couponFrequency: 'monthly' }));
    expect(grid.couponObs).toHaveLength(6);
    expect(grid.couponObs[grid.couponObs.length - 1]).toBe(grid.nSteps);
  });

  it('callObs is empty when callType is none', () => {
    const grid = buildGrid(baseCoupon({ callType: 'none' }));
    expect(grid.callObs).toEqual([]);
  });

  it('callObs mirrors the periodic construction when callable', () => {
    const grid = buildGrid(
      baseCoupon({ tenorYears: 1, callType: 'constant', callFrequency: 'quarterly' }),
    );
    expect(grid.callObs).toEqual([63, 126, 189, 252]);
  });

  it('dtYears * nSteps equals tenorYears', () => {
    const grid = buildGrid(baseCoupon({ tenorYears: 1.5 }));
    expect(grid.dtYears * grid.nSteps).toBeCloseTo(1.5, 10);
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
