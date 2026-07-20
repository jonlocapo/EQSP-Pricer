import { describe, expect, it } from 'vitest';
import type { AccumulatorSpec } from '../src/model/product';
import type { EvaluatorContext, PricingGrid } from '../src/engine/payoffs/types';
import { makeAccumulatorEvaluator } from '../src/engine/payoffs/accumulator';

// 20 daily steps, weekly settlement (4 periods of 5 days each).
const grid: PricingGrid = {
  nSteps: 20,
  dtYears: 1 / 252,
  tenorYears: 20 / 252,
  couponObs: [],
  callObs: [],
  settlementObs: [5, 10, 15, 20],
};

function ctx(rate = 0): EvaluatorContext {
  return {
    market: { spot: 100, vol: 0.2, rate, divYield: 0, currency: 'EUR' },
    grid,
    df: (t: number) => Math.exp(-rate * t),
  };
}

function baseSpec(overrides: Partial<AccumulatorSpec> = {}): AccumulatorSpec {
  return {
    kind: 'accumulator',
    direction: 'accumulate',
    underlyings: [{ name: 'TEST' }],
    currency: 'EUR',
    strikePct: 100,
    upfrontPct: 0,
    tenorYears: 20 / 252,
    settlementFrequency: 'weekly',
    dailyShares: 1000,
    koTriggerPct: 500, // effectively unreachable unless overridden
    koSettlement: 'ko0',
    gearing: 1,
    guaranteePeriods: 0,
    ...overrides,
  };
}

function flatDays(value: number, count: number): number[] {
  return new Array(count).fill(value);
}

describe('accumulator', () => {
  it('flat path below strike, gearing 2: every day geared, every period settles the same loss', () => {
    const spec = baseSpec({ strikePct: 100, gearing: 2, dailyShares: 1000 });
    const ev = makeAccumulatorEvaluator(spec, ctx());
    const spots = new Float64Array([100, ...flatDays(90, 20)]);
    const out = ev(spots);
    // strike=100, spot=90<100 -> gearing 2x every day -> 2000 shares/day.
    // Each period: 5 days * 2000 = 10000 accumulated shares; cashflow = 10000*(90-100) = -100000.
    // 4 periods -> pv = -400000. estimatedNotional = 1000*20*100 = 2,000,000.
    // pvPct = 100*(-400000)/2,000,000 = -20.
    expect(out.pvPct).toBeCloseTo(-20, 10);
    expect(out.koEvent).toBe(false);
    expect(out.lifeYears).toBeCloseTo(20 / 252, 10);
  });

  it('path crossing trigger on day 7, ko1: accumulates through day 7 only in period 2', () => {
    const spec = baseSpec({ strikePct: 200, gearing: 2, dailyShares: 1000, koTriggerPct: 110, koSettlement: 'ko1' });
    const ev = makeAccumulatorEvaluator(spec, ctx());
    // strike=200 keeps every day below strike -> gearing always 2x, decoupling share-count from the KO test.
    const spots = new Float64Array([
      100,
      105, 105, 105, 105, 105, // period 1 (days 1-5), settles day5 @105
      105, 115, 115, 115, 115, // period 2 (days 6-10), settles day10 @115; trigger 110 hit on day7
      120, 120, 120, 120, 120, // period 3 (days 11-15) - no accumulation (cutoff=8)
      120, 120, 120, 120, 120, // period 4 (days 16-20) - no accumulation
    ]);
    const out = ev(spots);
    // koIdx = 7 (first spot >= 110); ko1 -> cutoff = 8.
    // period1 (days1-5): all accumulate (i<8) -> 5*2000=10000 shares; cashflow=10000*(105-200)=-950000.
    // period2 (days6-10): only i=6,7 < 8 accumulate -> 2*2000=4000 shares; cashflow=4000*(115-200)=-340000.
    // period3,4: 0 accumulation -> 0 cashflow.
    // pv = -950000 - 340000 = -1,290,000. estimatedNotional = 1000*20*200 = 4,000,000.
    // pvPct = 100*(-1290000)/4000000 = -32.25.
    expect(out.pvPct).toBeCloseTo(-32.25, 10);
    expect(out.koEvent).toBe(true);
    // last accumulating day = 7, which settles in period 2 (grid index 10).
    expect(out.lifeYears).toBeCloseTo(10 / 252, 10);
  });

  it('guaranteePeriods 1 with KO on day 3, ko0: period 1 still fully accumulates', () => {
    const spec = baseSpec({
      strikePct: 200,
      gearing: 2,
      dailyShares: 1000,
      koTriggerPct: 110,
      koSettlement: 'ko0',
      guaranteePeriods: 1,
    });
    const ev = makeAccumulatorEvaluator(spec, ctx());
    const spots = new Float64Array([
      100,
      105, 105, 115, 105, 105, // period 1 (days 1-5): trigger hit on day 3 but guaranteed
      120, 120, 120, 120, 120, // period 2 (days 6-10): cutoff=3, no accumulation
      120, 120, 120, 120, 120, // period 3
      120, 120, 120, 120, 120, // period 4
    ]);
    const out = ev(spots);
    // koIdx=3 (spot 115>=110); ko0 -> cutoff=3.
    // period1: p=1<=guaranteePeriods(1) -> accumulates all 5 days regardless of cutoff.
    //   shares = 5*2000 = 10000; cashflow = 10000*(105-200) = -950000 (settles @ day5 spot 105).
    // period2-4: p>1 and i>=cutoff(3) for all their days -> 0 accumulation, 0 cashflow.
    // pv = -950000. estimatedNotional = 1000*20*200 = 4,000,000.
    // pvPct = 100*(-950000)/4,000,000 = -23.75.
    expect(out.pvPct).toBeCloseTo(-23.75, 10);
    expect(out.koEvent).toBe(true);
    expect(out.lifeYears).toBeCloseTo(5 / 252, 10);
  });

  it('gearing days mix: share count follows the per-day above/below-strike rule', () => {
    const spec = baseSpec({ strikePct: 100, gearing: 2, dailyShares: 1000, koTriggerPct: 500 });
    const ev = makeAccumulatorEvaluator(spec, ctx());
    const spots = new Float64Array([
      100,
      105, 95, 105, 95, 110, // period 1: days with spot>=100 get 1x, spot<100 get 2x -> shares = 1+2+1+2+1 = 7 units of dailyShares = 7000
      100, 100, 100, 100, 100, // period 2: settles flat at strike -> 0 cashflow regardless of share count
      100, 100, 100, 100, 100, // period 3: same
      100, 100, 100, 100, 100, // period 4: same
    ]);
    const out = ev(spots);
    // never KO'd (trigger 500 unreachable) -> every day accumulates.
    // period1 shares = 1000*(1+2+1+2+1) = 7000; cashflow = 7000*(110-100) = 70000 (settles @ day5 spot 110).
    // periods 2-4 settle exactly at strike (spot=100=strike) -> cashflow 0 regardless of accumulated shares.
    // pv = 70000. estimatedNotional = 1000*20*100 = 2,000,000.
    // pvPct = 100*70000/2,000,000 = 3.5.
    expect(out.pvPct).toBeCloseTo(3.5, 10);
    expect(out.koEvent).toBe(false);
    // never KO'd -> last accumulating day is the final grid step (20).
    expect(out.lifeYears).toBeCloseTo(20 / 252, 10);
  });

  it('biweekly settlement: flat path below strike, gearing 2, settlementObs every 10 steps', () => {
    // Same 20-day grid but re-declared with biweekly spacing (nSteps=20 -> [10,20]).
    const biweeklyGrid: PricingGrid = { ...grid, settlementObs: [10, 20] };
    const spec = baseSpec({ strikePct: 100, gearing: 2, dailyShares: 1000, settlementFrequency: 'biweekly' });
    const ev = makeAccumulatorEvaluator(spec, { ...ctx(), grid: biweeklyGrid });
    const spots = new Float64Array([100, ...flatDays(90, 20)]);
    const out = ev(spots);
    // strike=100, spot=90<100 -> gearing 2x every day -> 2000 shares/day.
    // Each period: 10 days * 2000 = 20000 accumulated shares; cashflow = 20000*(90-100) = -200000.
    // 2 periods -> pv = -400000. estimatedNotional = 1000*20*100 = 2,000,000.
    // pvPct = 100*(-400000)/2,000,000 = -20.
    expect(out.pvPct).toBeCloseTo(-20, 10);
    expect(out.koEvent).toBe(false);
    expect(out.lifeYears).toBeCloseTo(20 / 252, 10);
  });

  it('rate > 0: each period cashflow discounted at its own settlement date', () => {
    const spec = baseSpec({ strikePct: 100, gearing: 2, dailyShares: 1000, koTriggerPct: 500 });
    const rate = 0.05;
    const ev = makeAccumulatorEvaluator(spec, ctx(rate));
    const spots = new Float64Array([100, ...flatDays(90, 20)]);
    const out = ev(spots);
    // Same mechanics as the flat-path test but discounted: each period settles
    // -100000 at its own settlement time (5,10,15,20 steps * 1/252 years).
    const perPeriod = -100000;
    const notional = 1000 * 20 * 100;
    const pv =
      perPeriod * Math.exp(-rate * (5 / 252)) +
      perPeriod * Math.exp(-rate * (10 / 252)) +
      perPeriod * Math.exp(-rate * (15 / 252)) +
      perPeriod * Math.exp(-rate * (20 / 252));
    const expected = (100 * pv) / notional;
    expect(out.pvPct).toBeCloseTo(expected, 10);
  });

  // --- Decumulator (direction: 'decumulate') mirror cases -------------------
  // Mirror rules: KO when S <= trigger (trigger below spot); geared on days
  // with S > strike; per-share cashflow = strike - S_settle.

  it('decumulate: flat path above strike, gearing 2: every day geared, every period settles the same loss', () => {
    const spec = baseSpec({ direction: 'decumulate', strikePct: 100, gearing: 2, dailyShares: 1000, koTriggerPct: 10 });
    const ev = makeAccumulatorEvaluator(spec, ctx());
    const spots = new Float64Array([100, ...flatDays(110, 20)]);
    const out = ev(spots);
    // strike=100, spot=110>100 -> geared (sell double when losing) every day -> 2000 shares/day.
    // Each period: 5*2000=10000 shares; cashflow = 10000*(100-110) = -100000.
    // 4 periods -> pv = -400000. estimatedNotional = 1000*20*100 = 2,000,000.
    // pvPct = 100*(-400000)/2,000,000 = -20.
    expect(out.pvPct).toBeCloseTo(-20, 10);
    expect(out.koEvent).toBe(false);
    expect(out.lifeYears).toBeCloseTo(20 / 252, 10);
  });

  it('decumulate: path falling through trigger on day 7, ko1: accumulates through day 7 only in period 2', () => {
    const spec = baseSpec({
      direction: 'decumulate',
      strikePct: 50,
      gearing: 2,
      dailyShares: 1000,
      koTriggerPct: 90,
      koSettlement: 'ko1',
    });
    const ev = makeAccumulatorEvaluator(spec, ctx());
    // strike=50 keeps every day above strike -> gearing always 2x, decoupling share-count from the KO test.
    const spots = new Float64Array([
      100,
      95, 95, 95, 95, 95, // period 1 (days 1-5), settles day5 @95
      95, 85, 85, 85, 85, // period 2 (days 6-10), settles day10 @85; trigger 90 hit on day7 (85<=90)
      80, 80, 80, 80, 80, // period 3 (days 11-15) - no accumulation (cutoff=8)
      80, 80, 80, 80, 80, // period 4 (days 16-20) - no accumulation
    ]);
    const out = ev(spots);
    // koIdx = 7 (first spot <= 90); ko1 -> cutoff = 8.
    // period1 (days1-5): all accumulate (i<8) -> 5*2000=10000 shares; cashflow=10000*(50-95)=-450000.
    // period2 (days6-10): only i=6,7 < 8 accumulate -> 2*2000=4000 shares; cashflow=4000*(50-85)=-140000.
    // period3,4: 0 accumulation -> 0 cashflow.
    // pv = -450000 - 140000 = -590,000. estimatedNotional = 1000*20*50 = 1,000,000.
    // pvPct = 100*(-590000)/1,000,000 = -59.
    expect(out.pvPct).toBeCloseTo(-59, 10);
    expect(out.koEvent).toBe(true);
    // last accumulating day = 7, which settles in period 2 (grid index 10).
    expect(out.lifeYears).toBeCloseTo(10 / 252, 10);
  });

  it('decumulate: guaranteePeriods 1 with KO on day 3, ko0: period 1 still fully accumulates', () => {
    const spec = baseSpec({
      direction: 'decumulate',
      strikePct: 50,
      gearing: 2,
      dailyShares: 1000,
      koTriggerPct: 90,
      koSettlement: 'ko0',
      guaranteePeriods: 1,
    });
    const ev = makeAccumulatorEvaluator(spec, ctx());
    const spots = new Float64Array([
      100,
      95, 95, 85, 95, 95, // period 1 (days 1-5): trigger hit on day 3 (85<=90) but guaranteed
      80, 80, 80, 80, 80, // period 2 (days 6-10): cutoff=3, no accumulation
      80, 80, 80, 80, 80, // period 3
      80, 80, 80, 80, 80, // period 4
    ]);
    const out = ev(spots);
    // koIdx=3 (spot 85<=90); ko0 -> cutoff=3.
    // period1: p=1<=guaranteePeriods(1) -> accumulates all 5 days regardless of cutoff.
    //   shares = 5*2000 = 10000; cashflow = 10000*(50-95) = -450000 (settles @ day5 spot 95).
    // period2-4: p>1 and i>=cutoff(3) for all their days -> 0 accumulation, 0 cashflow.
    // pv = -450000. estimatedNotional = 1000*20*50 = 1,000,000.
    // pvPct = 100*(-450000)/1,000,000 = -45.
    expect(out.pvPct).toBeCloseTo(-45, 10);
    expect(out.koEvent).toBe(true);
    expect(out.lifeYears).toBeCloseTo(5 / 252, 10);
  });

  it('decumulate: gearing days mix: share count follows the per-day above/below-strike rule', () => {
    const spec = baseSpec({
      direction: 'decumulate',
      strikePct: 100,
      gearing: 2,
      dailyShares: 1000,
      koTriggerPct: 10,
    });
    const ev = makeAccumulatorEvaluator(spec, ctx());
    const spots = new Float64Array([
      100,
      105, 95, 105, 95, 110, // period 1: days with spot>strike get 2x, spot<strike get 1x -> shares = 2+1+2+1+2 = 8 units of dailyShares = 8000
      100, 100, 100, 100, 100, // period 2: settles flat at strike -> 0 cashflow regardless of share count
      100, 100, 100, 100, 100, // period 3: same
      100, 100, 100, 100, 100, // period 4: same
    ]);
    const out = ev(spots);
    // never KO'd (trigger 10 unreachable from above) -> every day accumulates.
    // period1 shares = 1000*(2+1+2+1+2) = 8000; cashflow = 8000*(100-110) = -80000 (settles @ day5 spot 110).
    // periods 2-4 settle exactly at strike (spot=100=strike) -> cashflow 0 regardless of accumulated shares.
    // pv = -80000. estimatedNotional = 1000*20*100 = 2,000,000.
    // pvPct = 100*(-80000)/2,000,000 = -4.
    expect(out.pvPct).toBeCloseTo(-4, 10);
    expect(out.koEvent).toBe(false);
    // never KO'd -> last accumulating day is the final grid step (20).
    expect(out.lifeYears).toBeCloseTo(20 / 252, 10);
  });
});
