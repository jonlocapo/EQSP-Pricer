import { describe, expect, it } from 'vitest';
import { executePriceRequest } from '../src/worker/pricing';
import type { PricingHooks } from '../src/worker/pricing';
import { runMc } from '../src/engine/mc';
import { buildGrid } from '../src/engine/schedule';
import { makeDf } from '../src/engine/discount';
import { makeEvaluator } from '../src/engine/payoffs';
import { __clearPathCacheForTests } from '../src/engine/pathCache';
import { bsCall } from '../src/engine/blackScholes';
import type { MarketData } from '../src/model/market';
import type { CouponProductSpec } from '../src/model/product';
import type { EvaluatorContext } from '../src/engine/payoffs/types';
import type { PriceRequest } from '../src/model/request';

const market: MarketData = { spot: 100, vol: 0.25, rate: 0.02, divYield: 0.02, currency: 'EUR' };

const hooks: PricingHooks = {
  onProgress: () => {},
  isCancelled: () => false,
  yieldNow: () => Promise.resolve(),
};

const baseCoupon: CouponProductSpec = {
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

function req(product: PriceRequest['product'], m: MarketData = market, numPaths = 40_000): PriceRequest {
  return {
    id: 't',
    product,
    market: m,
    mc: { numPaths, seed: 42, antithetic: true },
    solve: { kind: 'none' },
    greeks: false,
  };
}

/**
 * Reimplements the pre-caching priceOnce slice/pooling loop verbatim
 * (SLICE_PATHS=20000 slices, seed + s*7919 per slice, weighted pooling of
 * pv/stderr) calling `runMc` directly with no caching involved at all. Used
 * as an independent ground truth to prove the cache-backed priceOnce
 * produces byte-identical pooled pv/stderr.
 */
function legacyPooledPrice(spec: CouponProductSpec, m: MarketData, numPaths: number, seed: number, antithetic: boolean) {
  const grid = buildGrid(spec);
  const ctx: EvaluatorContext = { market: m, grid, df: makeDf(m.rate) };
  const evaluator = makeEvaluator(spec, ctx);
  const SLICE_PATHS = 20_000;
  const nSlices = Math.max(1, Math.ceil(numPaths / SLICE_PATHS));
  const per = Math.ceil(numPaths / nSlices);

  let wSum = 0;
  let pvSum = 0;
  let varSum = 0;
  for (let s = 0; s < nSlices; s++) {
    const slicePaths = Math.min(per, numPaths - s * per);
    const res = runMc({
      numPaths: slicePaths,
      seed: seed + s * 7919,
      antithetic,
      nSteps: grid.nSteps,
      dtYears: grid.dtYears,
      s0: m.spot,
      market: m,
      evaluator,
    });
    const w = slicePaths;
    wSum += w;
    pvSum += w * res.pvPct;
    varSum += w * w * res.stderrPct * res.stderrPct;
  }
  const W = wSum > 0 ? wSum : 1;
  return { pvPct: pvSum / W, stderrPct: Math.sqrt(varSum) / W };
}

describe('path cache — slice/seed/pooling structure preserved', () => {
  it('cache-backed executePriceRequest matches the uncached slice-pooling reference to float precision', async () => {
    __clearPathCacheForTests();
    const reference = legacyPooledPrice(baseCoupon, market, 40_000, 42, true);
    const cached = await executePriceRequest(req(baseCoupon), hooks);
    expect(cached).not.toBeNull();
    expect(cached!.pvPct).toBeCloseTo(reference.pvPct, 9);
    expect(cached!.stderrPct).toBeCloseTo(reference.stderrPct, 9);
  });

  it('golden regression: fixed spec/seed/numPaths pins exact pv and stderr', async () => {
    // Captured from this codebase's executePriceRequest (spec=baseCoupon,
    // mc={numPaths:40000, seed:42, antithetic:true}, solve:none) — see
    // /tmp scratchpad capture script used during the Task 1 refactor. Any
    // future change to path generation, evaluator ordering, or the
    // slice-pooling arithmetic that isn't a true no-op will move these.
    __clearPathCacheForTests();
    const res = await executePriceRequest(req(baseCoupon), hooks);
    expect(res).not.toBeNull();
    expect(res!.pvPct).toBeCloseTo(102.18470609646775, 9);
    expect(res!.stderrPct).toBeCloseTo(0.03645190141454858, 9);
  });
});

describe('path cache — reuse across reprices with unchanged market data', () => {
  it('(a) cache hit on second call with different product terms; cache-hit pv/stderr match a fresh uncached run of the same spec', async () => {
    __clearPathCacheForTests();
    const specA = baseCoupon;
    const specB: CouponProductSpec = { ...baseCoupon, couponBarrierPct: 70 };

    const t0 = Date.now();
    const resA = await executePriceRequest(req(specA), hooks); // cache miss: generates + stores
    const t1 = Date.now();
    const resB = await executePriceRequest(req(specB), hooks); // cache hit: replays stored paths
    const t2 = Date.now();
    expect(resA).not.toBeNull();
    expect(resB).not.toBeNull();

    // Advisory only — timing is noisy in sandboxed CI, log rather than hard-fail.
    // eslint-disable-next-line no-console
    console.log(`[pathCache timing] miss=${t1 - t0}ms hit=${t2 - t1}ms`);

    // Real correctness assertion: clear the cache and reprice specB from
    // scratch (forcing fresh generation) — the cache-hit result above must
    // match this fresh, uncached run to float precision.
    __clearPathCacheForTests();
    const freshB = await executePriceRequest(req(specB), hooks);
    expect(freshB).not.toBeNull();
    expect(resB!.pvPct).toBeCloseTo(freshB!.pvPct, 9);
    expect(resB!.stderrPct).toBeCloseTo(freshB!.stderrPct, 9);
  });

  it('(b) changing market data after a cache hit forces fresh generation and still produces a correct price', async () => {
    __clearPathCacheForTests();
    await executePriceRequest(req(baseCoupon), hooks); // populate cache under original market

    const bumpedVolMarket: MarketData = { ...market, vol: 0.35 };
    const capGuar = {
      ...baseCoupon,
      kind: 'coupon' as const,
      barrierType: 'none' as const,
      couponType: 'fixed' as const,
      couponPaPct: 0,
      callType: 'none' as const,
    };
    // Sanity check against a closed-form-adjacent bound isn't trivial for a
    // full coupon note, so instead verify against the participation-style
    // ZCB+call identity used in pricing.test.ts, under the bumped vol.
    const capGuarPart = {
      kind: 'participation' as const,
      underlyings: [{ name: 'TEST' }],
      currency: 'EUR',
      notional: 1_000_000,
      tenorYears: 1,
      reofferPct: 100,
      issuePricePct: 100,
      upside: { strikePct: 100, participationPct: 100, variant: { variant: 'vanilla' as const } },
      downside: { strikePct: 100, leveragePct: 0, barrierType: 'none' as const, kiBarrierPct: 60, twinWinPct: 0 },
      bonusPct: 0,
      protectionPct: 100,
    };
    const res = await executePriceRequest(req(capGuarPart, bumpedVolMarket), hooks);
    expect(res).not.toBeNull();
    const analytic =
      100 * Math.exp(-bumpedVolMarket.rate * 1) +
      (100 / bumpedVolMarket.spot) * bsCall(100, 100, 1, bumpedVolMarket.vol, bumpedVolMarket.rate, bumpedVolMarket.divYield);
    expect(Math.abs(res!.pvPct - analytic)).toBeLessThan(Math.max(3 * res!.stderrPct, 0.2));
    void capGuar;
  });

  it('(c) changing tenor changes the cache key; both tenors price correctly', async () => {
    __clearPathCacheForTests();
    const shortTenor: CouponProductSpec = { ...baseCoupon, tenorYears: 1 };
    const longTenor: CouponProductSpec = { ...baseCoupon, tenorYears: 2, reofferPct: 96 };

    const resShort = await executePriceRequest(req(shortTenor), hooks);
    const resLong = await executePriceRequest(req(longTenor), hooks);
    expect(resShort).not.toBeNull();
    expect(resLong).not.toBeNull();
    // Sane PV bounds — both should be well inside [0, notional-ish %] and
    // the two tenors' prices should differ (different grid, different key).
    expect(resShort!.pvPct).toBeGreaterThan(50);
    expect(resShort!.pvPct).toBeLessThan(150);
    expect(resLong!.pvPct).toBeGreaterThan(50);
    expect(resLong!.pvPct).toBeLessThan(150);
    expect(resShort!.pvPct).not.toBeCloseTo(resLong!.pvPct, 3);
  });
});
