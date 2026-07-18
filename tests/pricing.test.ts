import { describe, expect, it } from 'vitest';
import { executePriceRequest } from '../src/worker/pricing';
import type { PricingHooks } from '../src/worker/pricing';
import { bsCall } from '../src/engine/blackScholes';
import type { MarketData } from '../src/model/market';
import type { CouponProductSpec, ParticipationSpec } from '../src/model/product';
import type { PriceRequest } from '../src/model/request';

const market: MarketData = { spot: 100, vol: 0.25, rate: 0.02, divYield: 0.02, currency: 'EUR' };

const hooks: PricingHooks = {
  onProgress: () => {},
  isCancelled: () => false,
  yieldNow: () => Promise.resolve(),
};

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

function req(product: PriceRequest['product'], solve: PriceRequest['solve']): PriceRequest {
  return {
    id: 't',
    product,
    market,
    mc: { numPaths: 100_000, seed: 42, antithetic: true },
    solve,
    greeks: false,
  };
}

describe('executePriceRequest', () => {
  it('prices capital guaranteed note as ZCB + call (identity)', async () => {
    const res = await executePriceRequest(req(capGuar, { kind: 'none' }), hooks);
    expect(res).not.toBeNull();
    const analytic =
      100 * Math.exp(-market.rate * 1) + (100 / market.spot) * bsCall(100, 100, 1, 0.25, 0.02, 0.02);
    expect(Math.abs(res!.pvPct - analytic)).toBeLessThan(Math.max(3 * res!.stderrPct, 0.2));
    expect(res!.pvCcy).toBeCloseTo((res!.pvPct / 100) * 1_000_000, 6);
  });

  it('solves coupon so PV hits reoffer, and repricing at the solved coupon confirms it', async () => {
    const solved = await executePriceRequest(req(brc, { kind: 'couponPa' }), hooks);
    expect(solved).not.toBeNull();
    expect(solved!.solvedValue).toBeDefined();
    expect(solved!.solvedValue!).toBeGreaterThan(0);
    expect(solved!.solvedValue!).toBeLessThan(50);
    // Final pricing is done at the solved coupon: PV must sit on the target.
    expect(Math.abs(solved!.pvPct - 98.5)).toBeLessThan(0.05);

    const reprice = await executePriceRequest(
      req({ ...brc, couponPaPct: solved!.solvedValue! }, { kind: 'none' }),
      hooks,
    );
    expect(Math.abs(reprice!.pvPct - 98.5)).toBeLessThan(0.05);
  });

  it('autocall diagnostics are sane (high cumulative call prob at 100% barrier)', async () => {
    const res = await executePriceRequest(req(brc, { kind: 'none' }), hooks);
    const cum = (res!.diagnostics.callProb ?? []).reduce((a, b) => a + b, 0);
    expect(cum).toBeGreaterThan(0.5);
    expect(res!.diagnostics.kiProb).toBeGreaterThan(0);
    expect(res!.diagnostics.kiProb).toBeLessThan(0.5);
    expect(res!.diagnostics.expectedLifeYears).toBeGreaterThan(0.2);
    expect(res!.diagnostics.expectedLifeYears).toBeLessThan(1.01);
  });

  it('respects cancellation', async () => {
    let calls = 0;
    const res = await executePriceRequest(req(brc, { kind: 'none' }), {
      ...hooks,
      isCancelled: () => ++calls > 2,
    });
    expect(res).toBeNull();
  });
});
