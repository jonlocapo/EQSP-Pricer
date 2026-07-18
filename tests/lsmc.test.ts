import { describe, expect, it } from 'vitest';
import { makeDf } from '../src/engine/discount';
import { priceIssuerCallable } from '../src/engine/lsmc';
import { buildGrid } from '../src/engine/schedule';
import type { MarketData } from '../src/model/market';
import type { CashflowExtractor } from '../src/engine/payoffs/types';
import type { CouponProductSpec } from '../src/model/product';

const market: MarketData = { spot: 100, vol: 0.25, rate: 0.02, divYield: 0.02, currency: 'EUR' };
const s0 = 100;
const numPaths = 50_000;
const seed = 2024;

function baseSpec(overrides: Partial<CouponProductSpec>): CouponProductSpec {
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
    callType: 'issuerCallable',
    callFrequency: 'quarterly',
    callFromPeriod: 1,
    callBarrierPct: 100,
    stepDownPct: 0,
    customCallBarriersPct: [],
    couponType: 'fixed',
    couponFrequency: 'quarterly',
    couponBarrierPct: 0,
    couponPaPct: 0,
    acCouponType: 'none',
    acCouponPct: 0,
    ...overrides,
  };
}

/** Note paying a fixed quarterly coupon (couponPaPct annualized) plus 100
 * principal at maturity. No barrier / knock-in logic — purely to exercise
 * the LSMC call-decision machinery. */
function makeNoteCashflows(couponObsIdx: number[], nSteps: number, couponPaPct: number): CashflowExtractor {
  const perPeriod = couponPaPct / 4; // quarterly
  return (_spots: Float64Array) => {
    const gridIndices = [...couponObsIdx];
    const amountsPct = couponObsIdx.map((idx) => (idx === nSteps ? perPeriod + 100 : perPeriod));
    return { gridIndices, amountsPct };
  };
}

describe('priceIssuerCallable (LSMC)', () => {
  it('with zero coupons and r>0, issuer never calls: PV ≈ 100·df(T)', () => {
    const spec = baseSpec({ couponPaPct: 0, tenorYears: 1 });
    const grid = buildGrid(spec);
    const cashflows = makeNoteCashflows(grid.couponObs, grid.nSteps, 0);
    const df = makeDf(market.rate);

    const result = priceIssuerCallable({
      numPaths,
      seed,
      nSteps: grid.nSteps,
      s0,
      market,
      grid,
      cashflows,
      redemptionCostPct: () => 100,
      callObs: grid.callObs,
      callFromPeriod: spec.callFromPeriod,
      dtYears: grid.dtYears,
    });

    const neverCallPv = 100 * df(grid.tenorYears);
    const tol = Math.max(3 * result.stderrPct, 0.5);
    expect(Math.abs(result.pvPct - neverCallPv)).toBeLessThan(tol);
    // Should essentially never call.
    expect(result.callProb.every((p) => p < 0.01)).toBe(true);
  });

  it('with a rich coupon, issuer calls at the first date: PV ≈ (100 + coupon)·df(t1)', () => {
    const couponPaPct = 20; // 20% p.a., well above r=2%
    const spec = baseSpec({ couponPaPct, tenorYears: 1 });
    const grid = buildGrid(spec);
    const cashflows = makeNoteCashflows(grid.couponObs, grid.nSteps, couponPaPct);
    const df = makeDf(market.rate);

    const result = priceIssuerCallable({
      numPaths,
      seed,
      nSteps: grid.nSteps,
      s0,
      market,
      grid,
      cashflows,
      redemptionCostPct: () => 100,
      callObs: grid.callObs,
      callFromPeriod: spec.callFromPeriod,
      dtYears: grid.dtYears,
    });

    const t1 = grid.callObs[0] * grid.dtYears;
    const expectedPv = (100 + couponPaPct / 4) * df(t1);
    const tol = Math.max(3 * result.stderrPct, 0.5);
    expect(Math.abs(result.pvPct - expectedPv)).toBeLessThan(tol);
    // Almost always called at the very first opportunity.
    expect(result.callProb[0]).toBeGreaterThan(0.95);

    // Never-call baseline (bullet to maturity) for the same cashflow stream.
    let neverCallPv = 0;
    for (const idx of grid.couponObs) {
      const amt = idx === grid.nSteps ? couponPaPct / 4 + 100 : couponPaPct / 4;
      neverCallPv += amt * df(idx * grid.dtYears);
    }
    expect(result.pvPct).toBeLessThanOrEqual(neverCallPv + tol);
  });
});
