import { describe, expect, it } from 'vitest';
import { executePriceRequest } from '../src/worker/pricing';
import { DEFAULT_MC } from '../src/model/request';
import { DEFAULT_COUPON_SPEC, DEFAULT_PARTICIPATION } from '../src/state/tradeStore';
import type { PriceRequest } from '../src/model/request';

/**
 * B3 of the worst-of prerequisites: freeze the PRICES that are about to be put
 * at risk.
 *
 * The one-asset case is the anchor the basket work must reproduce exactly (the
 * structural `if (assets.length === 1) { existing code }` guard). This test
 * pins three products at full double precision, so "the one-asset case still
 * matches afterwards" is a number, not a claim: the collapsed generator must
 * produce these same prices and standard errors, or the guard is not the
 * single-asset engine.
 *
 * The products chosen are exactly the ones going multi-asset: a conditional
 * coupon autocall with a European knock-in, the same with an American
 * knock-in (daily grid), and a participation note.
 */

const MARKET = { spot: 100, vol: 0.25, rate: 0.02, divYield: 0.02, currency: 'EUR' };

const HOOKS = {
  onProgress: () => undefined,
  isCancelled: () => false,
  yieldNow: async () => undefined,
};

function req(id: string, product: PriceRequest['product']): PriceRequest {
  return { id, product, market: MARKET, mc: DEFAULT_MC, solve: { kind: 'none' }, greeks: false };
}

describe('B3: single-asset golden prices, frozen for the basket work', () => {
  it('conditional coupon autocall, EUROPEAN knock-in', async () => {
    const r = await executePriceRequest(req('coupon-eu', { ...DEFAULT_COUPON_SPEC, tenorYears: 2 }), HOOKS);
    expect(r).not.toBeNull();
    expect(r!.pvPct).toBeCloseTo(101.03635986616035, 9);
    expect(r!.stderrPct).toBeCloseTo(0.040162185956051581, 9);
  });

  it('conditional coupon autocall, AMERICAN knock-in (daily grid)', async () => {
    const r = await executePriceRequest(
      req('coupon-us', { ...DEFAULT_COUPON_SPEC, tenorYears: 2, barrierType: 'american' }),
      HOOKS,
    );
    expect(r).not.toBeNull();
    expect(r!.pvPct).toBeCloseTo(99.601032014149851, 9);
    expect(r!.stderrPct).toBeCloseTo(0.041541525960817172, 9);
  });

  it('participation booster', async () => {
    const r = await executePriceRequest(req('participation-booster', DEFAULT_PARTICIPATION), HOOKS);
    expect(r).not.toBeNull();
    expect(r!.pvPct).toBeCloseTo(102.89510063742412, 9);
    expect(r!.stderrPct).toBeCloseTo(0.040449261444575453, 9);
  });
});
