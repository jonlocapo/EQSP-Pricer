import { describe, expect, it } from 'vitest';
import { buildDailyGrid, buildGrid } from '../src/engine/schedule';
import { makeDf } from '../src/engine/discount';
import { runMc } from '../src/engine/mc';
import { makeEvaluator } from '../src/engine/payoffs';
import { bsCall } from '../src/engine/blackScholes';
import { executePriceRequest } from '../src/worker/pricing';
import type { PricingHooks } from '../src/worker/pricing';
import type { MarketData } from '../src/model/market';
import type { CouponProductSpec, ParticipationSpec } from '../src/model/product';
import type { EvaluatorContext } from '../src/engine/payoffs/types';
import type { PriceRequest } from '../src/model/request';

/**
 * CORRECTNESS GATE for the adaptive time grid. For European-only
 * monitoring, stepping the GBM straight to each observation date, instead
 * of walking every day, is mathematically EXACT under GBM — log-increments
 * over a longer step are still exactly lognormal — not an approximation.
 * This file proves that empirically. The compact grid's price must agree
 * with an explicit daily-grid price of the SAME spec — same seed, market,
 * and paths, only the grid's step structure differs — to within Monte
 * Carlo error. It also separately pins a case where the closed-form ZCB +
 * BS call identity itself is the reference, so the proof is not circular.
 * Otherwise both MC runs could in principle share a bug and still agree
 * with each other.
 */

const market: MarketData = { spot: 100, vol: 0.25, rate: 0.02, divYield: 0.02, currency: 'EUR' };
const numPaths = 200_000;
const seed = 4242;

const hooks: PricingHooks = {
  onProgress: () => {},
  isCancelled: () => false,
  yieldNow: () => Promise.resolve(),
};

describe('adaptive grid — compact grid price agrees with the daily grid to within MC error', () => {
  it('coupon note, european KI + quarterly coupon/call: compact grid (buildGrid) vs explicit daily grid (buildDailyGrid)', () => {
    const spec: CouponProductSpec = {
      kind: 'coupon',
      underlyings: [{ name: 'TEST' }],
      currency: 'EUR',
      notional: 1_000_000,
      tenorYears: 1,
      reofferPct: 98.5,
      issuePricePct: 100,
      barrierType: 'european',
      kiBarrierPct: 60,
      putStrikePct: 100,
      downsideLeveragePct: 100,
      callType: 'constant',
      callFrequency: 'quarterly',
      callFromPeriod: 1,
      callBarrierPct: 100,
      stepDownPct: 0,
      customCallBarriersPct: [],
      couponType: 'conditional',
      couponFrequency: 'quarterly',
      couponBarrierPct: 60,
      couponPaPct: 8,
      acCouponType: 'none',
      acCouponPct: 0,
    };

    const compactGrid = buildGrid(spec);
    const dailyGrid = buildDailyGrid(spec);
    // Sanity: this spec really does get the speedup. The compact grid is
    // much smaller than the daily grid, and buildGrid picked the compact
    // path.
    expect(compactGrid.nSteps).toBeLessThan(dailyGrid.nSteps);
    expect(compactGrid.nSteps).toBe(4); // one step per quarter

    const compactCtx: EvaluatorContext = { market, grid: compactGrid, df: makeDf(market.rate) };
    const dailyCtx: EvaluatorContext = { market, grid: dailyGrid, df: makeDf(market.rate) };

    const compactResult = runMc({
      numPaths,
      seed,
      antithetic: true,
      nSteps: compactGrid.nSteps,
      dtYears: compactGrid.stepDt,
      s0: market.spot,
      market,
      evaluator: makeEvaluator(spec, compactCtx),
    });
    const dailyResult = runMc({
      numPaths,
      seed,
      antithetic: true,
      nSteps: dailyGrid.nSteps,
      dtYears: dailyGrid.stepDt,
      s0: market.spot,
      market,
      evaluator: makeEvaluator(spec, dailyCtx),
    });

    const combinedStderr = Math.sqrt(compactResult.stderrPct ** 2 + dailyResult.stderrPct ** 2);
    expect(Math.abs(compactResult.pvPct - dailyResult.pvPct)).toBeLessThan(3 * combinedStderr);
  });

  it('participation booster (pure terminal payoff): compact grid (1 step) vs explicit daily grid', () => {
    const spec: ParticipationSpec = {
      kind: 'participation',
      underlyings: [{ name: 'TEST' }],
      currency: 'EUR',
      notional: 1_000_000,
      tenorYears: 1,
      reofferPct: 100,
      issuePricePct: 100,
      upside: { strikePct: 100, participationPct: 150, variant: { variant: 'vanilla' } },
      downside: { strikePct: 100, leveragePct: 100, barrierType: 'none', kiBarrierPct: 60, twinWinPct: 0 },
      bonusPct: 0,
      protectionPct: 0,
    };

    const compactGrid = buildGrid(spec);
    const dailyGrid = buildDailyGrid(spec);
    expect(compactGrid.nSteps).toBe(1);

    const compactCtx: EvaluatorContext = { market, grid: compactGrid, df: makeDf(market.rate) };
    const dailyCtx: EvaluatorContext = { market, grid: dailyGrid, df: makeDf(market.rate) };

    const compactResult = runMc({
      numPaths,
      seed,
      antithetic: true,
      nSteps: compactGrid.nSteps,
      dtYears: compactGrid.stepDt,
      s0: market.spot,
      market,
      evaluator: makeEvaluator(spec, compactCtx),
    });
    const dailyResult = runMc({
      numPaths,
      seed,
      antithetic: true,
      nSteps: dailyGrid.nSteps,
      dtYears: dailyGrid.stepDt,
      s0: market.spot,
      market,
      evaluator: makeEvaluator(spec, dailyCtx),
    });

    const combinedStderr = Math.sqrt(compactResult.stderrPct ** 2 + dailyResult.stderrPct ** 2);
    expect(Math.abs(compactResult.pvPct - dailyResult.pvPct)).toBeLessThan(3 * combinedStderr);
  });

  it('capital-guaranteed participation (compact grid, through the full pricing pipeline) matches the closed-form ZCB + BS call identity', async () => {
    // Independent reference. This is not just "the two MC runs agree with
    // each other", which a shared bug could still satisfy. The compact
    // grid's result must match an analytic formula outside the MC engine
    // entirely — the same identity tests/pricing.test.ts uses for the
    // daily-grid case.
    const capGuar: ParticipationSpec = {
      kind: 'participation',
      underlyings: [{ name: 'TEST' }],
      currency: 'EUR',
      notional: 1_000_000,
      tenorYears: 1,
      reofferPct: 100,
      issuePricePct: 100,
      upside: { strikePct: 100, participationPct: 100, variant: { variant: 'vanilla' } },
      downside: { strikePct: 100, leveragePct: 0, barrierType: 'none', kiBarrierPct: 60, twinWinPct: 0 },
      bonusPct: 0,
      protectionPct: 100,
    };

    const grid = buildGrid(capGuar);
    expect(grid.nSteps).toBe(1); // confirms this really is exercising the compact-grid path

    const req: PriceRequest = {
      id: 't',
      product: capGuar,
      market,
      mc: { numPaths, seed, antithetic: true },
      solve: { kind: 'none' },
      greeks: false,
    };
    const res = await executePriceRequest(req, hooks);
    expect(res).not.toBeNull();

    const analytic =
      100 * Math.exp(-market.rate * 1) +
      (100 / market.spot) * bsCall(100, 100, 1, market.vol, market.rate, market.divYield);
    expect(Math.abs(res!.pvPct - analytic)).toBeLessThan(Math.max(3 * res!.stderrPct, 0.2));
  });
});
