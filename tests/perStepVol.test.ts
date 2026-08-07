import { describe, expect, it } from 'vitest';
import { runMc } from '../src/engine/mc';
import { makeEvaluator } from '../src/engine/payoffs';
import { buildGrid } from '../src/engine/schedule';
import { makeDf } from '../src/engine/discount';
import { discountRate, type MarketData } from '../src/model/market';
import { DEFAULT_MC, type PriceRequest } from '../src/model/request';
import { executePriceRequest } from '../src/worker/pricing';
import type { PricingHooks } from '../src/worker/pricing';
import { buildVolSurface } from '../src/model/volSurface';
import { DEFAULT_COUPON_SPEC } from '../src/state/tradeStore';

const MARKET: MarketData = { spot: 100, vol: 0.25, rate: 0.02, divYield: 0.02, currency: 'EUR' };

const noopHooks: PricingHooks = {
  onProgress: () => undefined,
  isCancelled: () => false,
  yieldNow: async () => undefined,
};

function req(
  product: PriceRequest['product'],
  solve: PriceRequest['solve'],
  m: MarketData = MARKET,
): PriceRequest {
  return { id: 't', product, market: m, mc: DEFAULT_MC, solve, greeks: false };
}

/** A coupon note with a European 60% KI and a quarterly coupon: a
 * multi-period payoff whose early-period call probability depends on the
 * vol of the EARLY years, which is exactly what a per-step schedule feeds. */
const couponSpec = () => ({ ...DEFAULT_COUPON_SPEC, tenorYears: 2, callType: 'none' as const, barrierType: 'european' as const });

describe('per-step vol — bit identity', () => {
  it('a constant per-step vol schedule reproduces the flat-vol engine exactly (pv AND stderr)', () => {
    const grid = buildGrid(couponSpec());
    const spec = couponSpec();
    const ctx = { market: MARKET, grid, df: makeDf(discountRate(MARKET)) };
    const evaluator = makeEvaluator(spec, ctx);

    const flat = runMc({
      numPaths: 20_000,
      seed: 7,
      antithetic: true,
      nSteps: grid.nSteps,
      dtYears: grid.stepDt,
      s0: MARKET.spot,
      market: MARKET,
      evaluator,
    });
    const stepped = runMc({
      numPaths: 20_000,
      seed: 7,
      antithetic: true,
      nSteps: grid.nSteps,
      dtYears: grid.stepDt,
      s0: MARKET.spot,
      market: { ...MARKET, volPerStep: new Array(grid.nSteps).fill(MARKET.vol) },
      evaluator,
    });

    expect(stepped.pvPct).toBe(flat.pvPct);
    expect(stepped.stderrPct).toBe(flat.stderrPct);
  });

  it('a piecewise schedule with the same total variance prices a terminal payoff like the flat vol (within MC noise)', () => {
    // Total variance is additive: v1^2 * T/2 + v2^2 * T/2 = v^2 * T. Two
    // schedules with the same total variance give the same terminal
    // distribution, so a pure terminal payoff cannot tell them apart. This
    // is the property the per-step construction (forward total variance per
    // step) is designed to preserve.
    const grid = buildGrid(couponSpec());
    const spec = couponSpec();
    const ctx = { market: MARKET, grid, df: makeDf(discountRate(MARKET)) };
    const evaluator = makeEvaluator(spec, ctx);
    const nSteps = 126;
    const stepDt = new Float64Array(nSteps).fill(spec.tenorYears / nSteps);
    const half = nSteps / 2;
    const v1 = 0.3;
    const v2 = 0.2;
    const flatVol = Math.sqrt((half * v1 * v1 + half * v2 * v2) / nSteps);

    const opts = {
      numPaths: 100_000,
      seed: 11,
      antithetic: true,
      nSteps,
      dtYears: stepDt,
      s0: MARKET.spot,
      evaluator,
    };
    const flat = runMc({ ...opts, market: { ...MARKET, vol: flatVol } });
    const stepped = runMc({
      ...opts,
      market: {
        ...MARKET,
        vol: flatVol,
        volPerStep: [...new Array(half).fill(v1), ...new Array(nSteps - half).fill(v2)],
      },
    });

    expect(Math.abs(stepped.pvPct - flat.pvPct)).toBeLessThan(0.05);
  });
});

describe('per-step vol — pipeline integration', () => {
  /** A two-slice surface, flat across strike (so the risk strike does not
   * matter), with a genuine TERM structure: 20% at 1y, 30% at 2y. The old
   * engine priced everything at the 2y slice (30%); per-step pricing uses
   * ~20% for the early years. */
  function termSurface() {
    const points = [70, 80, 90, 100, 110, 120].map((k) => ({ strike: k, iv: 0.2 }));
    const points2 = [70, 80, 90, 100, 110, 120].map((k) => ({ strike: k, iv: 0.3 }));
    return buildVolSurface(
      {
        spot: 100,
        source: 'test',
        slices: [
          { tYears: 1, calls: [], puts: points },
          { tYears: 2, calls: [], puts: points2 },
        ],
      },
      { rate: 0.02, divYield: 0.02 },
    );
  }

  it('a term-structured surface prices the early years at the early-year vol: the note is worth MORE than at the 2y vol flat', async () => {
    const spec = couponSpec();
    const withTerm = await executePriceRequest(
      req(spec, { kind: 'none' }, { ...MARKET, vol: 0.3, volSurface: termSurface() }),
      noopHooks,
    );
    const flatAtLong = await executePriceRequest(req(spec, { kind: 'none' }, { ...MARKET, vol: 0.3 }), noopHooks);
    expect(withTerm).not.toBeNull();
    expect(flatAtLong).not.toBeNull();
    expect(withTerm!.basis?.volStepwise).toBe(true);
    // Lower early-year vol means a smaller short-put value and a smaller
    // barrier-breach probability, so the note is worth more than if the
    // whole life ran at the 30% final-tenor vol.
    expect(withTerm!.pvPct).toBeGreaterThan(flatAtLong!.pvPct + 0.2);
  });

  it('no surface reports flat pricing and no per-step schedule', async () => {
    const spec = couponSpec();
    const flat = await executePriceRequest(req(spec, { kind: 'none' }), noopHooks);
    expect(flat!.basis?.volStepwise).toBeUndefined();
    expect(flat!.basis?.volSource).toBe('flat');
  });
});
