import { describe, expect, it } from 'vitest';
import { PathBatchGenerator } from '../src/engine/gbm';
import { executePriceRequest } from '../src/worker/pricing';
import type { PricingHooks } from '../src/worker/pricing';
import { __clearPathCacheForTests } from '../src/engine/pathCache';
import type { LegQuantoParams, MarketData } from '../src/model/market';
import type { CouponProductSpec } from '../src/model/product';
import type { PriceRequest } from '../src/model/request';

/**
 * The multi-currency worst-of basket.
 *
 * Two properties carry this feature, and each has a test below:
 *  1. A SINGLE-CURRENCY basket must be bit-identical to the engine that could
 *     not price a multi-currency one at all. No leg of it carries quanto
 *     params, so no drift may move by one bit.
 *  2. A QUANTO leg must drift at the rate the quanto measure says, which the
 *     tests check against a forward computed by hand, not against "the number
 *     changed".
 */

const hooks: PricingHooks = {
  onProgress: () => {},
  isCancelled: () => false,
  yieldNow: () => Promise.resolve(),
};

/** A three-leg EUR basket. Every leg settles in the note currency, so no leg
 * carries quanto params. */
const singleCurrencyMarket: MarketData = {
  spot: 100,
  vol: 0.22,
  rate: 0.025,
  divYield: 0.018,
  currency: 'EUR',
  basket: {
    assets: [
      { vol: 0.22, divYield: 0.018 },
      { vol: 0.31, divYield: 0.026 },
      { vol: 0.27, divYield: 0.011 },
    ],
    correlation: [
      [1, 0.55, 0.4],
      [0.55, 1, 0.45],
      [0.4, 0.45, 1],
    ],
  },
};

const worstOfSpec: CouponProductSpec = {
  kind: 'coupon',
  underlyings: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
  notional: 1_000_000,
  tenorYears: 2,
  reofferPct: 98.5,
  issuePricePct: 100,
  barrierType: 'european',
  kiBarrierPct: 60,
  putStrikePct: 100,
  downsideLeveragePct: 100,
  callType: 'constant',
  callFrequency: 'quarterly',
  callFromPeriod: 2,
  callBarrierPct: 100,
  stepDownPct: 0,
  customCallBarriersPct: [],
  couponType: 'conditional',
  couponFrequency: 'quarterly',
  couponBarrierPct: 60,
  couponPaPct: 9,
  acCouponType: 'none',
  acCouponPct: 0,
};

function req(market: MarketData): PriceRequest {
  return {
    id: 't',
    product: worstOfSpec,
    market,
    mc: { numPaths: 40_000, seed: 42, antithetic: true },
    solve: { kind: 'none' },
    greeks: false,
  };
}

describe('a single-currency basket is untouched by the per-leg quanto work', () => {
  it('golden regression: pv AND stderr to 1e-9 for a fixed 3-leg spec and seed', async () => {
    // Captured from executePriceRequest on the commit BEFORE per-leg quanto
    // existed, with exactly this spec, market, seed and path count. Not one
    // leg here carries quanto params, so `buildBasketCoefficients` must take
    // the same branch, with the same operand order, and produce the same
    // doubles. A change here means a single-currency basket moved, which the
    // economics do not permit: nothing about it changed.
    __clearPathCacheForTests();
    const res = await executePriceRequest(req(singleCurrencyMarket), hooks);
    expect(res).not.toBeNull();
    expect(res!.pvPct).toBeCloseTo(95.95987491169306, 9);
    expect(res!.stderrPct).toBeCloseTo(0.10345795569226686, 9);
  });

  it('a quanto leg at the note rate with zero equity-FX correlation is the same price', async () => {
    // The quanto drift reduces to the note-currency drift exactly when the
    // leg's rate IS the note rate and the correlation is zero. Subtracting a
    // zero product changes no double, so this must hold to 1e-9, not just to
    // MC noise. It pins the SHAPE of the formula: a stray sign or a missing
    // dividend would break it while a "does the price move" test passed.
    const neutral: LegQuantoParams = {
      currency: 'USD',
      rateUnderlying: singleCurrencyMarket.rate,
      fxVol: 0.12,
      corrEqFx: 0,
    };
    const withNeutralQuanto: MarketData = {
      ...singleCurrencyMarket,
      basket: {
        assets: singleCurrencyMarket.basket!.assets.map((a, i) => (i === 1 ? { ...a, quanto: neutral } : a)),
        correlation: singleCurrencyMarket.basket!.correlation,
      },
    };
    __clearPathCacheForTests();
    const res = await executePriceRequest(req(withNeutralQuanto), hooks);
    expect(res).not.toBeNull();
    expect(res!.pvPct).toBeCloseTo(95.95987491169306, 9);
    expect(res!.stderrPct).toBeCloseTo(0.10345795569226686, 9);
  });
});

/**
 * Mean terminal performance of the worst leg, with its standard error. One
 * step to maturity keeps the comparison to the closed-form forward exact in
 * the time discretisation, so any gap is the drift and nothing else.
 */
function meanTerminalPerf(market: MarketData, paths = 400_000, T = 1): { mean: number; stderr: number } {
  const gen = new PathBatchGenerator(20260812, 1, 100, market, T);
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let p = 0; p < paths / 2; p++) {
    const { plus, minus } = gen.nextPair();
    for (const path of [plus, minus]) {
      const v = path[1] / path[0];
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return { mean, stderr: Math.sqrt(variance / n) };
}

/**
 * Two IDENTICAL legs at correlation 1. The worst leg is then either leg, so
 * the worst-of performance is one leg's performance and its expectation is
 * that leg's forward. This is what lets a basket test check a per-leg drift
 * against a hand-computed forward. See tests/basketEngine.test.ts, which uses
 * the same construction for the single-asset collapse.
 */
function twinLegBasket(vol: number, div: number, quanto?: LegQuantoParams): MarketData {
  const leg = { vol, divYield: div, ...(quanto ? { quanto } : {}) };
  return {
    spot: 100,
    vol,
    rate: 0.02,
    divYield: div,
    currency: 'EUR',
    basket: {
      assets: [leg, leg],
      correlation: [
        [1, 1],
        [1, 1],
      ],
    },
  };
}

describe('a quanto leg drifts at the quanto forward', () => {
  const VOL = 0.24;
  const DIV = 0.01;
  const NOTE_RATE = 0.02;
  const usdLeg: LegQuantoParams = { currency: 'USD', rateUnderlying: 0.045, fxVol: 0.09, corrEqFx: -0.35 };

  it('matches the hand-computed forward exp(mu*T), and moves the right way against the note-currency leg', () => {
    // mu = r_leg - q - borrow - rho * sigma * sigmaFX
    //    = 0.045 - 0.01 - 0 - (-0.35 * 0.24 * 0.09)
    //    = 0.035 + 0.00756 = 0.04256
    const mu = usdLeg.rateUnderlying - DIV - usdLeg.corrEqFx * VOL * usdLeg.fxVol;
    expect(mu).toBeCloseTo(0.04256, 12);

    const quantoRun = meanTerminalPerf(twinLegBasket(VOL, DIV, usdLeg));
    expect(Math.abs(quantoRun.mean - Math.exp(mu))).toBeLessThan(4 * quantoRun.stderr + 1e-4);

    // The same basket with both legs in the note currency drifts at
    // 0.02 - 0.01 = 0.01. The USD leg's forward is HIGHER: the US rate is
    // 2.5 points above the EUR rate, and the negative equity-FX correlation
    // adds a further 0.756 points instead of taking one away.
    const noteRun = meanTerminalPerf(twinLegBasket(VOL, DIV));
    const muNote = NOTE_RATE - DIV;
    expect(Math.abs(noteRun.mean - Math.exp(muNote))).toBeLessThan(4 * noteRun.stderr + 1e-4);
    expect(quantoRun.mean).toBeGreaterThan(noteRun.mean);
  });

  it('changes sign with the correlation, which is the whole quanto correction', () => {
    // Positive equity-FX correlation LOWERS the drift, negative raises it.
    // A sign error here would still pass a "the price moved" test.
    const positive = { ...usdLeg, corrEqFx: 0.35 };
    const zero = { ...usdLeg, corrEqFx: 0 };
    const negative = { ...usdLeg, corrEqFx: -0.35 };
    const means = [positive, zero, negative].map((q) => meanTerminalPerf(twinLegBasket(VOL, DIV, q), 200_000).mean);
    expect(means[0]).toBeLessThan(means[1]);
    expect(means[1]).toBeLessThan(means[2]);
    // The gap either side of zero is the same correction with opposite signs.
    const correction = 0.35 * VOL * usdLeg.fxVol;
    expect(means[1] / means[0]).toBeCloseTo(Math.exp(correction), 3);
    expect(means[2] / means[1]).toBeCloseTo(Math.exp(correction), 3);
  });

  it('reads market.quanto as the primary leg, and lets the leg’s own block win', () => {
    // `market.quanto` describes the primary underlying, which is leg 0. A
    // basket built from the existing market panel carries leg 0's parameters
    // there, so the engine must use them rather than price leg 0 as a
    // note-currency leg (see model/market.ts's `legQuantoOf`).
    const viaMarket: MarketData = { ...twinLegBasket(VOL, DIV), quanto: usdLeg };
    // Both legs must be quanto for the twin-leg collapse to hold, so give leg
    // 1 the same block explicitly and leave leg 0 to `market.quanto`.
    viaMarket.basket = {
      assets: [{ vol: VOL, divYield: DIV }, { vol: VOL, divYield: DIV, quanto: usdLeg }],
      correlation: viaMarket.basket!.correlation,
    };
    const mu = usdLeg.rateUnderlying - DIV - usdLeg.corrEqFx * VOL * usdLeg.fxVol;
    const run = meanTerminalPerf(viaMarket);
    expect(Math.abs(run.mean - Math.exp(mu))).toBeLessThan(4 * run.stderr + 1e-4);
  });
});
