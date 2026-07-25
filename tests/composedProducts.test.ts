import { describe, expect, it } from 'vitest';
import type { CouponProductSpec } from '../src/model/product';
import type { EvaluatorContext, PricingGrid } from '../src/engine/payoffs/types';
import { makeCouponEvaluator } from '../src/engine/payoffs/couponProducts';
import { compileContract } from '../src/engine/combinators/compile';
import { buildCatapult, type CatapultTerms } from '../src/engine/combinators/products';
import { makeContractObservables } from '../src/engine/combinators/observables';

/**
 * Products the modular payoff layer already expresses, verified by their
 * ECONOMICS rather than by pinned numbers.
 *
 * The point of this file is scope: two of the three products below need no new
 * engine code at all, only the existing fields used in the right combination.
 * Testing them documents that and stops a future "add a one-star mode" from
 * duplicating a mechanic the model already has.
 */

const grid: PricingGrid = {
  nSteps: 4,
  dtYears: 0.25,
  tenorYears: 1,
  times: [0, 0.25, 0.5, 0.75, 1],
  stepDt: Float64Array.from([0.25, 0.25, 0.25, 0.25]),
  couponObs: [1, 2, 3, 4],
  callObs: [1, 2, 3, 4],
  settlementObs: [],
};

/** Zero rates, so redemption percentages read directly as PV. */
const ctx: EvaluatorContext = {
  market: { spot: 100, vol: 0.2, rate: 0, divYield: 0, currency: 'EUR' },
  grid,
  df: () => 1,
};

/** A flat path that ends at `perfT` — enough to read a maturity redemption. */
function pathEndingAt(perfT: number): Float64Array {
  const s0 = 100;
  return Float64Array.from([s0, s0, s0, s0, s0 * perfT]);
}

function couponSpec(overrides: Partial<CouponProductSpec> = {}): CouponProductSpec {
  return {
    kind: 'coupon',
    underlyings: [{ name: 'TEST' }],
    currency: 'EUR',
    notional: 1_000_000,
    tenorYears: 1,
    reofferPct: 100,
    issuePricePct: 100,
    barrierType: 'european',
    kiBarrierPct: 70,
    putStrikePct: 100,
    downsideLeveragePct: 100,
    callType: 'none',
    callFrequency: 'quarterly',
    callFromPeriod: 1,
    callBarrierPct: 100,
    stepDownPct: 0,
    customCallBarriersPct: [],
    couponType: 'fixed',
    couponFrequency: 'quarterly',
    couponBarrierPct: 0,
    couponPaPct: 0, // isolate the redemption leg
    acCouponType: 'none',
    acCouponPct: 0,
    ...overrides,
  };
}

describe('one-star / airbag note — expressible with existing fields, no new mechanic', () => {
  // An airbag (a.k.a. one-star) measures the loss from the BARRIER instead of
  // par, so breaching the barrier does not immediately cost you the full
  // shortfall from 100. In this model that is exactly:
  //     putStrikePct    = kiBarrierPct
  //     leveragePct     = 10000 / kiBarrierPct   (the app's AUTO leverage)
  // which is the raw-shortfall convention the engine already implements.
  const barrier = 70;
  const airbag = couponSpec({
    kiBarrierPct: barrier,
    putStrikePct: barrier,
    downsideLeveragePct: 10000 / barrier,
  });
  const plainRc = couponSpec({ kiBarrierPct: barrier, putStrikePct: 100, downsideLeveragePct: 100 });

  it('pays par exactly AT the barrier, where a plain reverse convertible already loses', () => {
    const evalAirbag = makeCouponEvaluator(airbag, ctx);
    const evalPlain = makeCouponEvaluator(plainRc, ctx);
    const atBarrier = pathEndingAt(barrier / 100);

    // Knocked in (perf < barrier is false at exactly the barrier for a
    // strict '<' test, so nudge just below to make the put attach).
    const justBelow = pathEndingAt(barrier / 100 - 1e-9);
    expect(evalAirbag(justBelow).pvPct).toBeCloseTo(100, 6);
    // Same path through a plain RC loses the full shortfall from par.
    expect(evalPlain(justBelow).pvPct).toBeCloseTo(70, 6);

    // Above the barrier neither has knocked in: both pay par.
    expect(evalAirbag(atBarrier).pvPct).toBeCloseTo(100, 9);
    expect(evalPlain(atBarrier).pvPct).toBeCloseTo(100, 9);
  });

  it('scales the loss from the barrier: perf = half the barrier pays half par', () => {
    const evalAirbag = makeCouponEvaluator(airbag, ctx);
    // perf 35% with a 70% barrier -> 100 * 0.35/0.70 = 50.
    expect(evalAirbag(pathEndingAt(0.35)).pvPct).toBeCloseTo(50, 6);
    // ...and a plain RC would pay only 35.
    expect(makeCouponEvaluator(plainRc, ctx)(pathEndingAt(0.35)).pvPct).toBeCloseTo(35, 6);
  });

  it('is strictly worth more to the holder than a plain RC on every knocked-in path', () => {
    const evalAirbag = makeCouponEvaluator(airbag, ctx);
    const evalPlain = makeCouponEvaluator(plainRc, ctx);
    for (const perf of [0.05, 0.2, 0.35, 0.5, 0.6, 0.69]) {
      const p = pathEndingAt(perf);
      expect(evalAirbag(p).pvPct).toBeGreaterThan(evalPlain(p).pvPct);
    }
    // Being worth more to the holder is why an airbag commands a LOWER coupon
    // for the same reoffer — the cushion has to be paid for.
  });
});

describe('autocall compositions via the combinator vehicle', () => {
  function catapult(overrides: Partial<CatapultTerms> = {}) {
    const terms: CatapultTerms = {
      tenorYears: 1,
      callFrequency: 'quarterly',
      callFromPeriod: 1,
      callBarrierPct: 100,
      couponPaPct: 0,
      participationPct: 100,
      upsideStrikePct: 100,
      protectionPct: 0,
      downsideLeveragePct: 100,
      putStrikePct: 100,
      barrierType: 'european',
      kiBarrierPct: 70,
      ...overrides,
    };
    const contract = buildCatapult(terms, grid);
    const compiled = compileContract(contract, ctx);
    const observables = makeContractObservables(contract.events.map((e) => e.gridIndex));
    return (spots: Float64Array) => compiled.outcome(observables(spots));
  }

  it('capital-guaranteed autocall: protection floors maturity redemption at par', () => {
    // protection 100 + no downside leverage = a guaranteed autocall.
    const guaranteed = catapult({ protectionPct: 100, downsideLeveragePct: 0, callBarrierPct: 1000 });
    for (const perf of [0.01, 0.3, 0.7, 1.0, 1.4]) {
      expect(guaranteed(pathEndingAt(perf)).pvPct).toBeGreaterThanOrEqual(100 - 1e-9);
    }
  });

  it('autocall + booster: upside participation above 100% gears the payoff', () => {
    // callBarrier out of reach so the note survives to maturity and the
    // participation leg is what is being measured.
    const oneToOne = catapult({ participationPct: 100, callBarrierPct: 1000 });
    const geared = catapult({ participationPct: 200, callBarrierPct: 1000 });

    const up = pathEndingAt(1.3);
    const gearedUpside = geared(up).pvPct - 100;
    const plainUpside = oneToOne(up).pvPct - 100;
    expect(gearedUpside).toBeCloseTo(2 * plainUpside, 6);

    // Gearing must not create value on the downside.
    const down = pathEndingAt(0.5);
    expect(geared(down).pvPct).toBeCloseTo(oneToOne(down).pvPct, 9);
  });

  it('a reachable autocall barrier redeems early instead of paying the maturity leg', () => {
    const callable = catapult({ callBarrierPct: 100, couponPaPct: 8 });
    // Flat at par: the first quarterly observation is at/above the 100%
    // barrier, so it autocalls at period 1 rather than running to maturity.
    const flat = pathEndingAt(1.0);
    const out = callable(flat);
    expect(out.calledAtPeriod).toBe(1);
    // Snowball coupon for one quarter of an 8% p.a. rate.
    expect(out.pvPct).toBeCloseTo(100 + 8 / 4, 6);
  });
});
