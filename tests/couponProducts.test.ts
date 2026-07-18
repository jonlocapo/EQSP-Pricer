import { describe, expect, it } from 'vitest';
import type { CouponProductSpec } from '../src/model/product';
import type { EvaluatorContext, PricingGrid } from '../src/engine/payoffs/types';
import { makeCouponEvaluator, makeCouponCashflowExtractor } from '../src/engine/payoffs/couponProducts';

// Grid: quarterly coupon + call observations, 1 year tenor, 4 periods.
const grid: PricingGrid = {
  nSteps: 4,
  dtYears: 0.25,
  tenorYears: 1,
  couponObs: [1, 2, 3, 4],
  callObs: [1, 2, 3, 4],
  settlementObs: [],
};

function ctx(rate = 0): EvaluatorContext {
  return {
    market: { spot: 100, vol: 0.2, rate, divYield: 0, currency: 'EUR' },
    grid,
    df: (t: number) => Math.exp(-rate * t),
  };
}

function baseSpec(overrides: Partial<CouponProductSpec> = {}): CouponProductSpec {
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
    couponBarrierPct: 100,
    couponPaPct: 8, // 2 per quarter
    acCouponType: 'none',
    acCouponPct: 0,
    ...overrides,
  };
}

function path(...vals: number[]): Float64Array {
  return new Float64Array(vals);
}

describe('coupon products', () => {
  it('fixed coupon, no call, no KI: pv = 4 coupons + 100', () => {
    const spec = baseSpec();
    const ev = makeCouponEvaluator(spec, ctx());
    const spots = path(100, 100, 100, 100, 100);
    const out = ev(spots);
    // coupon = 8/4 = 2 per period, 4 periods -> 8; perf_T = 1 >= putStrike 1 -> redemption 100
    expect(out.pvPct).toBeCloseTo(108, 10);
    expect(out.calledAtPeriod).toBeUndefined();
    expect(out.lifeYears).toBe(1);
  });

  it('conditional coupon skips exactly the obs below barrier', () => {
    const spec = baseSpec({ couponType: 'conditional', couponBarrierPct: 100 });
    const ev = makeCouponEvaluator(spec, ctx());
    const spots = path(100, 105, 95, 105, 105);
    const out = ev(spots);
    // coupon paid at obs1,3,4 (2 each) = 6; obs2 (perf 0.95 < 1) skipped; perf_T=1.05 -> redemption 100
    expect(out.pvPct).toBeCloseTo(3 * 2 + 100, 10);
  });

  it('memory coupon pays the missed coupon at the next qualifying obs (catch-up)', () => {
    const spec = baseSpec({ couponType: 'memory', couponBarrierPct: 100 });
    const ev = makeCouponEvaluator(spec, ctx());
    const spots = path(100, 105, 95, 105, 105);
    const out = ev(spots);
    // obs1: perf1.05>=1 pay 2 (missed=0)
    // obs2: perf0.95<1 -> missed=1, pay 0
    // obs3: perf1.05>=1 -> pay (1+missed)*2 = 4, missed reset to 0
    // obs4: perf1.05>=1 -> pay 2
    // total coupons = 2+0+4+2 = 8; redemption 100 (perf_T 1.05)
    expect(out.pvPct).toBeCloseTo(8 + 100, 10);
  });

  it('autocall constant barrier 100, snowball AC coupon: called at period 2', () => {
    const spec = baseSpec({
      callType: 'constant',
      callFromPeriod: 1,
      callBarrierPct: 100,
      acCouponType: 'snowball',
      acCouponPct: 4,
    });
    const ev = makeCouponEvaluator(spec, ctx());
    const spots = path(100, 95, 105, 999, 999);
    const out = ev(spots);
    // obs1: perf0.95<1 not called, coupon 2 paid (fixed)
    // obs2: perf1.05>=1 called; coupon 2 paid; redemption = 100 + 4*2/4 = 102
    // pv = 2 + 2 + 102 = 106
    expect(out.pvPct).toBeCloseTo(106, 10);
    expect(out.calledAtPeriod).toBe(2);
    expect(out.lifeYears).toBeCloseTo(0.5, 10);
  });

  it('autocall constant barrier 100, flat AC coupon: called at period 2, full flat coupon paid', () => {
    const spec = baseSpec({
      callType: 'constant',
      callFromPeriod: 1,
      callBarrierPct: 100,
      acCouponType: 'flat',
      acCouponPct: 4,
    });
    const ev = makeCouponEvaluator(spec, ctx());
    const spots = path(100, 95, 105, 999, 999);
    const out = ev(spots);
    // obs1: perf0.95<1 not called, coupon 2 paid (fixed)
    // obs2: perf1.05>=1 called; coupon 2 paid; redemption = 100 + 4 (flat, paid in full regardless of period)
    // pv = 2 + 2 + 104 = 108
    expect(out.pvPct).toBeCloseTo(108, 10);
    expect(out.calledAtPeriod).toBe(2);
    expect(out.lifeYears).toBeCloseTo(0.5, 10);
  });

  it('stepdown call barrier: called at period 3', () => {
    const spec = baseSpec({
      callType: 'stepdown',
      callFromPeriod: 2,
      callBarrierPct: 100,
      stepDownPct: 5,
      acCouponType: 'snowball',
      acCouponPct: 4,
    });
    const ev = makeCouponEvaluator(spec, ctx());
    // period1 not callable (j=1 < callFromPeriod 2); period2 barrier=100, perf<100 not called;
    // period3 barrier=100-5*(3-2)=95, perf 0.97 -> called.
    const spots = path(100, 50, 90, 97, 999);
    const out = ev(spots);
    // coupon paid obs1,2,3 (fixed) = 6; redemption at period3 = 100 + 4*3/4 = 103
    expect(out.pvPct).toBeCloseTo(6 + 103, 10);
    expect(out.calledAtPeriod).toBe(3);
    expect(out.lifeYears).toBeCloseTo(0.75, 10);
  });

  it('custom call barriers: called at period 3', () => {
    const spec = baseSpec({
      callType: 'custom',
      callFromPeriod: 1,
      customCallBarriersPct: [102, 101, 95, 90],
      acCouponType: 'snowball',
      acCouponPct: 4,
    });
    const ev = makeCouponEvaluator(spec, ctx());
    // period1 barrier 102, perf 1.00 -> not called; period2 barrier 101, perf 1.00 -> not called;
    // period3 barrier 95, perf 0.96 -> called.
    const spots = path(100, 100, 100, 96, 999);
    const out = ev(spots);
    // coupon paid obs1,2,3 (fixed) = 6; redemption at period3 = 100 + 4*3/4 = 103
    expect(out.pvPct).toBeCloseTo(6 + 103, 10);
    expect(out.calledAtPeriod).toBe(3);
  });

  it('european KI: perf_T below barrier -> geared put redemption', () => {
    const spec = baseSpec({
      couponPaPct: 0,
      barrierType: 'european',
      kiBarrierPct: 60,
      putStrikePct: 100,
      downsideLeveragePct: 100,
    });
    const ev = makeCouponEvaluator(spec, ctx());
    const spots = path(100, 90, 80, 70, 55);
    const out = ev(spots);
    // perf_T = 0.55 < 0.60 -> KI; redemption = 100*(1 - 1.0*(1-0.55)/1) = 55
    expect(out.pvPct).toBeCloseTo(55, 10);
    expect(out.kiEvent).toBe(true);
  });

  it('american KI: intra-path dip below barrier even though perf_T recovers', () => {
    const spec = baseSpec({
      couponPaPct: 0,
      barrierType: 'american',
      kiBarrierPct: 60,
      putStrikePct: 100,
      downsideLeveragePct: 100,
    });
    const ev = makeCouponEvaluator(spec, ctx());
    const spots = path(100, 55, 90, 90, 80);
    const out = ev(spots);
    // min daily perf = 0.55 < 0.60 -> KI; perf_T=0.8 -> redemption = 100*(1-(1-0.8)/1) = 80
    expect(out.pvPct).toBeCloseTo(80, 10);
    expect(out.kiEvent).toBe(true);
  });

  it("barrierType 'none': put always live, no dip needed", () => {
    const spec = baseSpec({
      couponPaPct: 0,
      barrierType: 'none',
      putStrikePct: 100,
      downsideLeveragePct: 100,
    });
    const ev = makeCouponEvaluator(spec, ctx());
    const spots = path(100, 90, 85, 82, 80);
    const out = ev(spots);
    // no KI concept; redemption = 100*(1-(1-0.8)/1) = 80
    expect(out.pvPct).toBeCloseTo(80, 10);
    expect(out.kiEvent).toBeUndefined();
  });

  it('european, no KI: perf_T above barrier -> par redemption', () => {
    const spec = baseSpec({
      couponPaPct: 0,
      barrierType: 'european',
      kiBarrierPct: 60,
    });
    const ev = makeCouponEvaluator(spec, ctx());
    const spots = path(100, 90, 80, 70, 65);
    const out = ev(spots);
    // perf_T = 0.65 >= 0.60 -> not KI -> redemption 100
    expect(out.pvPct).toBeCloseTo(100, 10);
    expect(out.kiEvent).toBe(false);
  });

  it('geared put with 50% leverage and 80% strike', () => {
    const spec = baseSpec({
      couponPaPct: 0,
      barrierType: 'none',
      putStrikePct: 80,
      downsideLeveragePct: 50,
    });
    const ev = makeCouponEvaluator(spec, ctx());
    const spots = path(100, 90, 80, 70, 60);
    const out = ev(spots);
    // perf_T = 0.6; industry-standard convention: leverage multiplies the raw
    // shortfall (not normalized by strike): shortfall = 80 - 100*0.6 = 20;
    // redemption = 100 - 0.5*20 = 90.
    expect(out.pvPct).toBeCloseTo(90, 10);
  });

  it('cashflow extractor: never-called walk matches fixed-coupon flows', () => {
    const spec = baseSpec({
      callType: 'constant',
      callFromPeriod: 1,
      callBarrierPct: 100,
      acCouponType: 'snowball',
      acCouponPct: 4,
      barrierType: 'none',
    });
    const { extractor, redemptionCostPct } = makeCouponCashflowExtractor(spec, ctx());
    // Path would trigger a call at period 2 under the plain evaluator, but the
    // extractor must ignore call and walk through to maturity.
    const spots = path(100, 95, 105, 105, 100);
    const flows = extractor(spots);
    expect(flows.gridIndices).toEqual([1, 2, 3, 4, 4]);
    // fixed coupon 2 at each of the 4 obs, then maturity redemption (perf_T=1 -> 100)
    expect(flows.amountsPct).toEqual([2, 2, 2, 2, 100]);
    expect(redemptionCostPct(2)).toBeCloseTo(100 + 4 * 2 / 4, 10);
    expect(redemptionCostPct(3)).toBeCloseTo(100 + 4 * 3 / 4, 10);
  });

  it('rate > 0: discounting applied via df', () => {
    const spec = baseSpec();
    const c = ctx(0.05);
    const ev = makeCouponEvaluator(spec, c);
    const spots = path(100, 100, 100, 100, 100);
    const out = ev(spots);
    const expected =
      2 * Math.exp(-0.05 * 0.25) +
      2 * Math.exp(-0.05 * 0.5) +
      2 * Math.exp(-0.05 * 0.75) +
      2 * Math.exp(-0.05 * 1) +
      100 * Math.exp(-0.05 * 1);
    expect(out.pvPct).toBeCloseTo(expected, 10);
  });
});
