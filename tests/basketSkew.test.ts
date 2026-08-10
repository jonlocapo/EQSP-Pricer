import { describe, expect, it } from 'vitest';
import { executePriceRequest } from '../src/worker/pricing';
import { __clearPathCacheForTests } from '../src/engine/pathCache';
import type { MarketData } from '../src/model/market';
import type { VolSurface } from '../src/model/volSurface';
import type { CouponProductSpec } from '../src/model/product';
import type { PricingHooks } from '../src/worker/pricing';

/**
 * Every leg of a worst-of prices at its OWN volatility, read at the risk
 * strike.
 *
 * Before this, a basket skipped the volatility surface completely. Every leg
 * simulated at its at-the-money volatility, including the leg that carries a
 * 60% knock-in. Equity skew lifts the downside strike, so the barrier was
 * priced too cheap and the note came out rich. These tests hold the fix in
 * place and, just as importantly, hold the no-surface path bit-identical, so
 * a hand-typed basket still prices exactly as it always did.
 */

const hooks: PricingHooks = {
  onProgress: () => {},
  isCancelled: () => false,
  yieldNow: () => Promise.resolve(),
};

/** A downward-sloping smile: volatility rises as the strike falls, which is
 * the shape equity index and single-stock surfaces actually have. `skew` is
 * the volatility added for every 100 points of strike below spot. */
function smile(atmVol: number, skew: number): VolSurface {
  return {
    spotRef: 100,
    source: 'test',
    slices: [0.5, 1, 3, 5].map((tYears) => ({
      tYears,
      points: [40, 60, 80, 100, 120].map((strike) => ({
        strike,
        iv: atmVol + (skew * (100 - strike)) / 100,
      })),
    })),
  };
}

/** A surface with no skew at all. It must price identically to no surface,
 * which is what `VolSurface.isFlat` promises. */
function flatSurface(atmVol: number): VolSurface {
  return { ...smile(atmVol, 0), isFlat: true };
}

const LEG_VOLS = [0.25, 0.28, 0.31];
const CORRELATION = [
  [1, 0.5, 0.5],
  [0.5, 1, 0.5],
  [0.5, 0.5, 1],
];

function basketMarket(surfaces?: (VolSurface | undefined)[]): MarketData {
  return {
    spot: 100,
    vol: LEG_VOLS[0],
    rate: 0.02,
    divYield: 0.02,
    currency: 'EUR',
    basket: {
      assets: LEG_VOLS.map((vol, i) => ({
        vol,
        divYield: 0.02,
        ...(surfaces?.[i] ? { volSurface: surfaces[i] } : {}),
      })),
      correlation: CORRELATION,
    },
  };
}

/** European monitoring, so the risk strike is the 60% knock-in. */
const spec: CouponProductSpec = {
  kind: 'coupon',
  underlyings: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
  notional: 1_000_000,
  tenorYears: 3,
  reofferPct: 100,
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

async function price(surfaces?: (VolSurface | undefined)[]) {
  __clearPathCacheForTests();
  const r = await executePriceRequest(
    {
      id: `skew-${Math.random()}`,
      product: spec,
      market: basketMarket(surfaces),
      mc: { numPaths: 40_000, seed: 7, antithetic: true },
      solve: { kind: 'none' },
      greeks: false,
    },
    hooks,
  );
  expect(r).not.toBeNull();
  return r!;
}

describe('worst-of baskets price every leg at its own volatility', () => {
  it('reads each leg at the risk strike, so a 60% knock-in prices on the downside smile', async () => {
    const noSurface = await price();
    const skewed = await price(LEG_VOLS.map((v) => smile(v, 0.2)));

    // The surface is read at the knock-in, not at the money.
    expect(skewed.basis!.volSource).toBe('surface');
    expect(skewed.basis!.riskStrikePct).toBe(60);

    // Each leg is lifted by the smile: 0.20 of skew over the 40 points from
    // spot down to the barrier adds 0.08 to every leg.
    const expectedAvg = LEG_VOLS.reduce((s, v) => s + v + 0.08, 0) / LEG_VOLS.length;
    expect(skewed.basis!.volUsed).toBeCloseTo(expectedAvg, 9);

    // Higher volatility on the leg that carries the barrier makes the note
    // worth LESS, because the issuer is short the down-and-in put. The gap is
    // large: this is the mispricing the fix removes, not a rounding effect.
    expect(skewed.pvPct).toBeLessThan(noSurface.pvPct - 5);
  });

  it('a dead-flat surface prices bit-identically to no surface at all', async () => {
    const noSurface = await price();
    const flat = await price(LEG_VOLS.map((v) => flatSurface(v)));

    // Same pv AND same stderr. A flat surface returns one volatility at every
    // strike, so it must not perturb a single path.
    expect(flat.pvPct).toBeCloseTo(noSurface.pvPct, 9);
    expect(flat.stderrPct).toBeCloseTo(noSurface.stderrPct, 9);
    expect(flat.basis!.volSource).toBe('flat');
  });

  it('reports the average of the legs, not leg one, as the volatility used', async () => {
    const noSurface = await price();
    // The legs are 25%, 28% and 31%. Reporting 25% describes a note nobody
    // priced.
    expect(noSurface.basis!.volUsed).toBeCloseTo(0.28, 9);
    expect(noSurface.basis!.volUsed).not.toBeCloseTo(LEG_VOLS[0], 6);
  });

  it('lifts only the legs that measured a surface and leaves the others alone', async () => {
    const noSurface = await price();
    const mixed = await price([smile(LEG_VOLS[0], 0.2), undefined, undefined]);

    // Legs two and three keep their typed volatility, so the reported average
    // moves by one leg's lift divided by three.
    expect(mixed.basis!.volSource).toBe('surface');
    expect(mixed.basis!.volUsed).toBeCloseTo(0.28 + 0.08 / 3, 9);
    expect(mixed.pvPct).toBeLessThan(noSurface.pvPct);
  });
});

/** A surface with a steep TERM STRUCTURE and no skew: 15% out to six months,
 * rising to 45% at five years. Flat across strikes, so the only thing it can
 * change is the step schedule. `isFlat` stays unset, because that flag means
 * "same vol at every point", and this surface is not that. */
function termStructure(): VolSurface {
  const byTenor: Record<number, number> = { 0.5: 0.15, 1: 0.2, 3: 0.35, 5: 0.45 };
  return {
    spotRef: 100,
    source: 'test',
    slices: [0.5, 1, 3, 5].map((tYears) => ({
      tYears,
      points: [40, 60, 80, 100, 120].map((strike) => ({ strike, iv: byTenor[tYears] })),
    })),
  };
}

describe('a basket leg carries its own term structure', () => {
  /**
   * The oracle. With perfect correlation and identical legs, every leg follows
   * the same path, so the worst of them IS that path. A two-leg worst-of must
   * then price like the single name on the same surface, term structure and
   * all.
   *
   * This is what catches a dropped per-leg schedule. If the basket ignored the
   * schedule it would simulate on one flat volatility while the single name
   * simulated stepwise, and on this surface those are 15% and 45% at the two
   * ends of the life. The gap would be points, not noise.
   */
  it('at correlation 1 with identical legs it matches the single name, stepwise schedule included', async () => {
    const surface = termStructure();
    const oneLeg = { ...spec, underlyings: [{ name: 'A' }] };
    const twoLeg = { ...spec, underlyings: [{ name: 'A' }, { name: 'B' }] };
    const mc = { numPaths: 60_000, seed: 11, antithetic: true } as const;

    __clearPathCacheForTests();
    const single = await executePriceRequest(
      {
        id: 'ts-single',
        product: oneLeg,
        market: { spot: 100, vol: 0.35, rate: 0.02, divYield: 0.02, currency: 'EUR', volSurface: surface },
        mc,
        solve: { kind: 'none' },
        greeks: false,
      },
      hooks,
    );

    __clearPathCacheForTests();
    const basket = await executePriceRequest(
      {
        id: 'ts-basket',
        product: twoLeg,
        market: {
          spot: 100,
          vol: 0.35,
          rate: 0.02,
          divYield: 0.02,
          currency: 'EUR',
          basket: {
            assets: [
              { vol: 0.35, divYield: 0.02, volSurface: surface },
              { vol: 0.35, divYield: 0.02, volSurface: surface },
            ],
            correlation: [
              [1, 1],
              [1, 1],
            ],
          },
        },
        mc,
        solve: { kind: 'none' },
        greeks: false,
      },
      hooks,
    );

    expect(single).not.toBeNull();
    expect(basket).not.toBeNull();
    // Both report a stepwise schedule, so both took the term-structure path.
    expect(single!.basis!.volStepwise).toBe(true);
    expect(basket!.basis!.volStepwise).toBe(true);
    // Agree inside sampling error. The two are not bit-identical even at
    // correlation 1: the basket accumulates log performance where the single
    // name multiplies levels, and the two consume normals differently. See
    // fillBasketPath. So compare against the combined standard error, the
    // same yardstick tests/basketEngine.test.ts uses.
    const tol = 4 * Math.hypot(single!.stderrPct, basket!.stderrPct);
    expect(Math.abs(basket!.pvPct - single!.pvPct)).toBeLessThan(tol);

    // And the schedule genuinely moved the price. A basket that ignored the
    // per-leg term structure would simulate the whole life on the 3-year
    // volatility, which on this surface is far from the year-one 15%.
    __clearPathCacheForTests();
    const flatVol = await executePriceRequest(
      {
        id: 'ts-flat',
        product: twoLeg,
        market: {
          spot: 100,
          vol: 0.35,
          rate: 0.02,
          divYield: 0.02,
          currency: 'EUR',
          basket: {
            assets: [
              { vol: 0.35, divYield: 0.02 },
              { vol: 0.35, divYield: 0.02 },
            ],
            correlation: [
              [1, 1],
              [1, 1],
            ],
          },
        },
        mc,
        solve: { kind: 'none' },
        greeks: false,
      },
      hooks,
    );
    expect(Math.abs(basket!.pvPct - flatVol!.pvPct)).toBeGreaterThan(tol);
  });

  it('a surface with no term structure attaches no schedule, so the flat path is kept', async () => {
    const noTs = await price(LEG_VOLS.map((v) => smile(v, 0.2)));
    // smile() gives the same vol at every tenor, so there is nothing to
    // schedule and the cheaper flat branch must stay in use.
    expect(noTs.basis!.volSource).toBe('surface');
    expect(noTs.basis!.volStepwise).toBeUndefined();
  });
});
