import { describe, expect, it } from 'vitest';
import { executePriceRequest, evaluatePriceSlice, sliceSizeOf } from '../src/worker/pricing';
import type { PricingHooks, SliceRunner } from '../src/worker/pricing';
import type { McRunResult } from '../src/engine/mc';
import { __clearPathCacheForTests } from '../src/engine/pathCache';
import type { MarketData } from '../src/model/market';
import type { CouponProductSpec } from '../src/model/product';
import type { PriceRequest } from '../src/model/request';

/**
 * These tests exercise the exact production `hooks.sliceRunner` extension
 * point that `src/worker/pricer.worker.ts`'s real Worker pool plugs into
 * (see `PoolSliceRunner` there). They just fake the "N workers" part
 * in-process, because real `postMessage`/`MessageChannel` Worker pools are
 * not available in vitest's node environment; realClient.ts/pricer.worker.ts
 * are exercised manually, in the browser. What is under test — and what is
 * actually at risk from farming slices across workers — is the pooling
 * arithmetic. Does resolving slices out of order, "on different workers",
 * still produce the same pv and stderr as the sequential single-worker
 * path? `FakePoolSliceRunner` below deliberately resolves LATER slice
 * indices FIRST, the opposite of arrival order, to prove the aggregation
 * in priceOnce reduces over `sliceIndices` in index order, regardless of
 * completion order.
 */
class FakePoolSliceRunner implements SliceRunner {
  async runSlices(
    spec: Parameters<SliceRunner['runSlices']>[0],
    market: Parameters<SliceRunner['runSlices']>[1],
    numPaths: number,
    seed: number,
    antithetic: boolean,
    sliceIndices: number[],
    onSliceDone: (slicePaths: number) => void,
  ): Promise<McRunResult[]> {
    const promises = sliceIndices.map(
      (sliceIndex, i) =>
        new Promise<McRunResult>((resolve) => {
          // Reverse completion order: the LAST job dispatched resolves FIRST.
          // This simulates slices landing on different workers that finish
          // in an order unrelated to dispatch order.
          const delayMs = (sliceIndices.length - i) * 2;
          setTimeout(() => {
            const result = evaluatePriceSlice(spec, market, numPaths, seed, antithetic, sliceIndex);
            onSliceDone(sliceSizeOf(numPaths, sliceIndex));
            resolve(result);
          }, delayMs);
        }),
    );
    return Promise.all(promises);
  }
}

const market: MarketData = { spot: 100, vol: 0.25, rate: 0.02, divYield: 0.02, currency: 'EUR' };

const americanCoupon: CouponProductSpec = {
  kind: 'coupon',
  underlyings: [{ name: 'TEST' }],
  currency: 'EUR',
  notional: 1_000_000,
  tenorYears: 1,
  reofferPct: 98.5,
  issuePricePct: 100,
  barrierType: 'american',
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

function req(numPaths: number): PriceRequest {
  return {
    id: 'pool-test',
    product: americanCoupon,
    market,
    mc: { numPaths, seed: 42, antithetic: true },
    solve: { kind: 'none' },
    greeks: false,
  };
}

function sequentialHooks(): PricingHooks {
  return { onProgress: () => {}, isCancelled: () => false, yieldNow: () => Promise.resolve() };
}

function pooledHooks(progressLog: number[]): PricingHooks {
  return {
    onProgress: (pathsDone) => progressLog.push(pathsDone),
    isCancelled: () => false,
    yieldNow: () => Promise.resolve(),
    sliceRunner: new FakePoolSliceRunner(),
  };
}

describe('worker pool — slice pooling is bit-identical to the sequential single-worker path', () => {
  it('pooled pv AND stderr match the sequential result to 1e-9 despite out-of-order slice completion', async () => {
    // 100k paths / SLICE_PATHS=20_000 (see pricing.ts) gives 5 slices on the
    // daily (american) grid — enough slices to actually exercise pooling.
    __clearPathCacheForTests();
    const sequential = await executePriceRequest(req(100_000), sequentialHooks());
    expect(sequential).not.toBeNull();

    __clearPathCacheForTests();
    const progressLog: number[] = [];
    const pooled = await executePriceRequest(req(100_000), pooledHooks(progressLog));
    expect(pooled).not.toBeNull();

    expect(pooled!.pvPct).toBeCloseTo(sequential!.pvPct, 9);
    expect(pooled!.stderrPct).toBeCloseTo(sequential!.stderrPct, 9);

    // Progress still advances monotonically to the full path count, even
    // though slices finish out of order. Aggregation must not regress or
    // double-count across "workers".
    expect(progressLog.length).toBeGreaterThan(0);
    for (let i = 1; i < progressLog.length; i++) {
      expect(progressLog[i]).toBeGreaterThanOrEqual(progressLog[i - 1]);
    }
    expect(progressLog[progressLog.length - 1]).toBe(100_000);
  });

  it('pooled result also matches a fresh, never-pooled, freshly-cached sequential run (not just a shared warm cache)', async () => {
    __clearPathCacheForTests();
    const progressLog: number[] = [];
    const pooled = await executePriceRequest(req(60_000), pooledHooks(progressLog));
    expect(pooled).not.toBeNull();

    __clearPathCacheForTests();
    const fresh = await executePriceRequest(req(60_000), sequentialHooks());
    expect(fresh).not.toBeNull();

    expect(pooled!.pvPct).toBeCloseTo(fresh!.pvPct, 9);
    expect(pooled!.stderrPct).toBeCloseTo(fresh!.stderrPct, 9);
  });
});
