import { describe, expect, it } from 'vitest';
import { executePriceRequest } from '../src/worker/pricing';
import type { PricingHooks } from '../src/worker/pricing';
import type { MarketData } from '../src/model/market';
import type { CouponProductSpec } from '../src/model/product';
import type { PriceRequest } from '../src/model/request';

const market: MarketData = { spot: 100, vol: 0.25, rate: 0.02, divYield: 0.02, currency: 'EUR' };

const hooks: PricingHooks = {
  onProgress: () => {},
  isCancelled: () => false,
  yieldNow: () => Promise.resolve(),
};

const brc: CouponProductSpec = {
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

function req(overrides: Partial<PriceRequest> = {}): PriceRequest {
  return {
    id: 't',
    product: brc,
    market,
    mc: { numPaths: 100_000, seed: 42, antithetic: true, previewNumPaths: 20_000 },
    // kiBarrier has a much wider natural bracket ([1, 100], hard [0.5, 100])
    // than e.g. couponPa's ([0, 25]) — cold-start bracket expansion +
    // Ridders takes noticeably more evaluations here, which is what makes
    // the warm-start speedup measurable rather than lost in the noise of an
    // already-narrow bracket.
    solve: { kind: 'kiBarrier' },
    greeks: false,
    ...overrides,
  };
}

describe('warm-started solver', () => {
  it('cold-start and warm-start converge to the same root, and warm-start uses fewer iterations', async () => {
    const cold = await executePriceRequest(req(), hooks);
    expect(cold).not.toBeNull();
    expect(cold!.solveWarmStart).toBeFalsy();
    expect(cold!.solvedValue).toBeDefined();

    const warm = await executePriceRequest(req({ warmStartValue: cold!.solvedValue }), hooks);
    expect(warm).not.toBeNull();
    expect(warm!.solveWarmStart).toBe(true);
    expect(warm!.solvedValue).toBeDefined();

    // Same root within the solver's tolY-driven precision — warm-starting
    // must change how fast the answer is found, never the answer.
    expect(Math.abs(warm!.solvedValue! - cold!.solvedValue!)).toBeLessThan(0.05);
    // Both must actually hit the reoffer target.
    expect(Math.abs(cold!.pvPct - 98.5)).toBeLessThan(0.05);
    expect(Math.abs(warm!.pvPct - 98.5)).toBeLessThan(0.05);

    expect(warm!.solveIterations!).toBeLessThan(cold!.solveIterations!);
  });

  it('falls back to cold-start bracket expansion when the warm guess is bad (outside the true bracket)', async () => {
    const cold = await executePriceRequest(req(), hooks);
    expect(cold).not.toBeNull();

    // A deliberately bad guess: kiBarrier's bracket is [1, 100], and the
    // true root here sits well inside it. Seed a guess pinned at the hard
    // upper bound so the tight warm bracket can't possibly contain the root.
    const warmBad = await executePriceRequest(req({ warmStartValue: 100 }), hooks);
    expect(warmBad).not.toBeNull();
    // The tight bracket around 100 doesn't contain the root, so this must
    // have fallen back to cold-start rather than diverging/failing.
    expect(warmBad!.solveWarmStart).toBeFalsy();
    expect(Math.abs(warmBad!.solvedValue! - cold!.solvedValue!)).toBeLessThan(0.05);
    expect(Math.abs(warmBad!.pvPct - 98.5)).toBeLessThan(0.05);
  });

  it('a full-path solve is the authoritative result; a reduced-path preview may be looser', async () => {
    const full = await executePriceRequest(req({ preview: false }), hooks);
    expect(full).not.toBeNull();
    expect(full!.preview).toBeFalsy();
    // Full-path solve must reprice to the reoffer target within the tight
    // solver tolerance — this is the authoritative value.
    expect(Math.abs(full!.pvPct - 98.5)).toBeLessThan(0.05);

    const preview = await executePriceRequest(req({ preview: true }), hooks);
    expect(preview).not.toBeNull();
    expect(preview!.preview).toBe(true);
    // Preview still hits the target reasonably (it's still a real root
    // find), but we only require the FULL result to meet the tight bar —
    // the preview is explicitly allowed to be noisier (fewer paths).
    expect(Math.abs(preview!.pvPct - 98.5)).toBeLessThan(0.5);

    // Reprice at the full solve's solved KI barrier and confirm it lands on
    // target — the standalone check that the authoritative value is correct
    // independent of the solve loop's own bookkeeping.
    const reprice = await executePriceRequest(
      req({ product: { ...brc, kiBarrierPct: full!.solvedValue! }, solve: { kind: 'none' }, preview: false }),
      hooks,
    );
    expect(Math.abs(reprice!.pvPct - 98.5)).toBeLessThan(0.05);
  });
});
