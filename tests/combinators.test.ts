import { describe, expect, it } from 'vitest';
import type { CouponProductSpec, ParticipationSpec } from '../src/model/product';
import type { EvaluatorContext, PathOutcome } from '../src/engine/payoffs/types';
import { buildGrid } from '../src/engine/schedule';
import { makeDf } from '../src/engine/discount';
import { PathBatchGenerator } from '../src/engine/gbm';
import { makeCouponEvaluator } from '../src/engine/payoffs/couponProducts';
import { makeParticipationEvaluator } from '../src/engine/payoffs/participation';
import { compileContract } from '../src/engine/combinators/compile';
import {
  buildCatapult,
  buildParticipation,
  buildReverseConvertible,
  type CatapultTerms,
} from '../src/engine/combinators/products';

/**
 * CORRECTNESS GATE for the v1 contract-combinator engine (src/engine/combinators).
 *
 * For the reverse-convertible and participation-booster families, this
 * proves per-path, field-by-field equivalence between:
 *   - the hand-written monolithic evaluator (makeCouponEvaluator /
 *     makeParticipationEvaluator) — the production path and correctness
 *     oracle, untouched by this PR, and
 *   - `compileContract(buildX(spec, grid), ctx).outcome(observables(spots))`
 *     — the combinator tree lowered through the exact same
 *     ObservablesEvaluator/OutcomeEvaluator split pathCache.ts consumes.
 *
 * The Catapult has no hand-written oracle, so it is instead checked for
 * sane, directionally-correct pricing behavior (monotonicity, floors).
 */

const market = { spot: 100, vol: 0.25, rate: 0.03, divYield: 0.01, currency: 'EUR' };

function samplePaths(n: number, nSteps: number, s0: number, seed: number): Float64Array[] {
  const gen = new PathBatchGenerator(seed, nSteps, s0, market, 1 / 252);
  const paths: Float64Array[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      const { plus } = gen.nextPair();
      paths.push(plus.slice());
    } else {
      paths.push(gen.nextSingle().slice());
    }
  }
  return paths;
}

function baseCoupon(overrides: Partial<CouponProductSpec> = {}): CouponProductSpec {
  return {
    kind: 'coupon',
    underlyings: [{ name: 'TEST' }],
    currency: 'EUR',
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
    ...overrides,
  };
}

function baseParticipation(overrides: Partial<ParticipationSpec> = {}): ParticipationSpec {
  return {
    kind: 'participation',
    underlyings: [{ name: 'TEST' }],
    currency: 'EUR',
    notional: 1_000_000,
    tenorYears: 2,
    reofferPct: 100,
    issuePricePct: 100,
    upside: { strikePct: 100, participationPct: 150, variant: { variant: 'vanilla' } },
    downside: { strikePct: 100, leveragePct: 100, barrierType: 'none', kiBarrierPct: 60, twinWinPct: 0 },
    bonusPct: 0,
    protectionPct: 0,
    ...overrides,
  };
}

function expectOutcomesEqual(a: PathOutcome, b: PathOutcome, tol = 0) {
  if (tol === 0) {
    expect(b.pvPct).toBe(a.pvPct);
  } else {
    expect(b.pvPct).toBeCloseTo(a.pvPct, tol);
  }
  expect(b.calledAtPeriod).toBe(a.calledAtPeriod);
  expect(b.kiEvent).toBe(a.kiEvent);
  expect(b.upsideKoEvent).toBe(a.upsideKoEvent);
  expect(b.koEvent).toBe(a.koEvent);
  expect(b.lifeYears).toBe(a.lifeYears);
}

const nSteps = 504; // 2y * 252
const nPaths = 60;
const pathSets = [samplePaths(nPaths, nSteps, 100, 1), samplePaths(nPaths, nSteps, 100, 999)];

describe('combinator engine — reverse convertible == makeCouponEvaluator (per-path, exact)', () => {
  const specs: { name: string; spec: CouponProductSpec }[] = [
    { name: 'plain RC (callType none, european KI, geared put)', spec: baseCoupon({ callType: 'none' }) },
    { name: 'european KI, conditional coupon, autocallable', spec: baseCoupon() },
    { name: 'american KI, conditional coupon', spec: baseCoupon({ barrierType: 'american' }) },
    { name: 'no KI barrier (plain RC, put always live)', spec: baseCoupon({ barrierType: 'none', callType: 'none' }) },
    { name: 'memory coupon', spec: baseCoupon({ couponType: 'memory' }) },
    { name: 'fixed coupon', spec: baseCoupon({ couponType: 'fixed' }) },
    { name: 'stepdown call barrier', spec: baseCoupon({ callType: 'stepdown', stepDownPct: 5 }) },
    {
      name: 'custom call barriers',
      spec: baseCoupon({
        callType: 'custom',
        callFrequency: 'quarterly',
        customCallBarriersPct: [105, 102, 100, 98, 96, 94, 92, 90],
      }),
    },
    { name: 'snowball AC coupon', spec: baseCoupon({ acCouponType: 'snowball', acCouponPct: 2 }) },
    { name: 'flat AC coupon', spec: baseCoupon({ acCouponType: 'flat', acCouponPct: 3 }) },
    { name: 'gearing downside 150, low ki', spec: baseCoupon({ downsideLeveragePct: 150, kiBarrierPct: 50 }) },
  ];

  for (const { name, spec } of specs) {
    it(name, () => {
      const grid = buildGrid(spec);
      const ctx: EvaluatorContext = { market, grid, df: makeDf(market.rate) };
      const oracle = makeCouponEvaluator(spec, ctx);
      const contract = buildReverseConvertible(spec, grid);
      const compiled = compileContract(contract, ctx);

      let count = 0;
      for (const paths of pathSets) {
        for (const p of paths) {
          const expected = oracle(p);
          const actual = compiled.outcome(compiled.observables(p));
          // Same arithmetic, same iteration order -> exact bit-for-bit match.
          expectOutcomesEqual(expected, actual, 0);
          count++;
        }
      }
      expect(count).toBe(pathSets.length * nPaths);
    });
  }
});

describe('combinator engine — participation booster == makeParticipationEvaluator (per-path, exact)', () => {
  const specs: { name: string; spec: ParticipationSpec }[] = [
    { name: 'vanilla booster, no barrier', spec: baseParticipation() },
    {
      name: 'callSpread upside, european KI',
      spec: baseParticipation({
        upside: { strikePct: 100, participationPct: 100, variant: { variant: 'callSpread', upperStrikePct: 140 } },
        downside: { strikePct: 100, leveragePct: 100, barrierType: 'european', kiBarrierPct: 70, twinWinPct: 0 },
      }),
    },
    {
      name: 'koRebate european, KI american',
      spec: baseParticipation({
        upside: {
          strikePct: 100,
          participationPct: 100,
          variant: { variant: 'koRebate', koBarrierPct: 130, koMonitoring: 'european', rebatePct: 12 },
        },
        downside: { strikePct: 100, leveragePct: 100, barrierType: 'american', kiBarrierPct: 65, twinWinPct: 0 },
      }),
    },
    {
      name: 'koRebate american, KI european',
      spec: baseParticipation({
        upside: {
          strikePct: 100,
          participationPct: 80,
          variant: { variant: 'koRebate', koBarrierPct: 120, koMonitoring: 'american', rebatePct: 8 },
        },
        downside: { strikePct: 100, leveragePct: 100, barrierType: 'european', kiBarrierPct: 60, twinWinPct: 0 },
      }),
    },
    {
      name: 'put-spread floored downside, KI american',
      spec: baseParticipation({
        downside: {
          strikePct: 100,
          leveragePct: 120,
          barrierType: 'american',
          kiBarrierPct: 60,
          twinWinPct: 0,
          putSpread: { lowerStrikePct: 70 },
        },
      }),
    },
    {
      name: 'twin-win, KI american',
      spec: baseParticipation({
        downside: { strikePct: 100, leveragePct: 100, barrierType: 'american', kiBarrierPct: 60, twinWinPct: 100 },
        bonusPct: 5,
      }),
    },
    {
      name: 'protection floor binds',
      spec: baseParticipation({
        downside: { strikePct: 100, leveragePct: 200, barrierType: 'none', kiBarrierPct: 60, twinWinPct: 0 },
        protectionPct: 90,
      }),
    },
  ];

  for (const { name, spec } of specs) {
    it(name, () => {
      const grid = buildGrid(spec);
      const ctx: EvaluatorContext = { market, grid, df: makeDf(market.rate) };
      const oracle = makeParticipationEvaluator(spec, ctx);
      const contract = buildParticipation(spec, grid);
      const compiled = compileContract(contract, ctx);

      for (const paths of pathSets) {
        for (const p of paths) {
          const expected = oracle(p);
          const actual = compiled.outcome(compiled.observables(p));
          expectOutcomesEqual(expected, actual, 0);
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Catapult: no hand-written oracle. Sanity/monotonicity checks instead.
// ---------------------------------------------------------------------------

function baseCatapult(overrides: Partial<CatapultTerms> = {}): CatapultTerms {
  return {
    tenorYears: 2,
    callFrequency: 'quarterly',
    callFromPeriod: 1,
    callBarrierPct: 100,
    couponPaPct: 8,
    participationPct: 150,
    upsideStrikePct: 100,
    protectionPct: 90,
    downsideLeveragePct: 100,
    putStrikePct: 100,
    barrierType: 'european',
    kiBarrierPct: 60,
    ...overrides,
  };
}

function priceAll(terms: CatapultTerms, paths: Float64Array[][]): PathOutcome[] {
  // buildGrid only needs tenorYears to determine nSteps/dtYears here; a
  // minimal participation spec is a convenient vehicle (its couponObs/[nSteps]
  // branch is irrelevant — the Catapult's own event grid indices come from
  // buildCatapult's own schedule builder, independent of this spec's terms).
  const grid = buildGrid(baseParticipation({ tenorYears: terms.tenorYears }));
  const ctx: EvaluatorContext = { market, grid, df: makeDf(market.rate) };
  const contract = buildCatapult(terms, grid);
  const compiled = compileContract(contract, ctx);
  const out: PathOutcome[] = [];
  for (const set of paths) for (const p of set) out.push(compiled.outcome(compiled.observables(p)));
  return out;
}

describe('combinator engine — Catapult (autocall + geared upside + protection floor): sanity properties', () => {
  it('protection floor holds: redemption at maturity never pays below protectionPct', () => {
    const terms = baseCatapult();
    const outcomes = priceAll(terms, pathSets);
    const df = makeDf(market.rate);
    for (const o of outcomes) {
      if (o.calledAtPeriod === undefined) {
        const T = terms.tenorYears;
        const redemptionPct = o.pvPct / df(T);
        expect(redemptionPct).toBeGreaterThanOrEqual(terms.protectionPct - 1e-9);
      }
    }
  });

  it('a higher autocall barrier strictly reduces (or leaves unchanged) the empirical call probability', () => {
    const low = priceAll(baseCatapult({ callBarrierPct: 95 }), pathSets);
    const high = priceAll(baseCatapult({ callBarrierPct: 130 }), pathSets);
    const callProb = (outs: PathOutcome[]) => outs.filter((o) => o.calledAtPeriod !== undefined).length / outs.length;
    expect(callProb(high)).toBeLessThanOrEqual(callProb(low));
    // and it should be a meaningfully different distribution for this vol/tenor, not a no-op
    expect(callProb(low)).toBeGreaterThan(callProb(high));
  });

  it('higher upside participation weakly increases average PV, holding everything else fixed', () => {
    const lowPart = priceAll(baseCatapult({ participationPct: 50, callBarrierPct: 1000 }), pathSets);
    const highPart = priceAll(baseCatapult({ participationPct: 300, callBarrierPct: 1000 }), pathSets);
    // callBarrierPct 1000 makes autocall unreachable so every path settles at
    // maturity, isolating the upside-participation effect.
    const avg = (outs: PathOutcome[]) => outs.reduce((s, o) => s + o.pvPct, 0) / outs.length;
    expect(avg(highPart)).toBeGreaterThan(avg(lowPart));
  });

  it('all sampled paths settle with a well-formed PathOutcome (lifeYears in range, no NaNs)', () => {
    const terms = baseCatapult();
    const outcomes = priceAll(terms, pathSets);
    for (const o of outcomes) {
      expect(Number.isFinite(o.pvPct)).toBe(true);
      expect(o.lifeYears).toBeGreaterThan(0);
      expect(o.lifeYears).toBeLessThanOrEqual(terms.tenorYears + 1e-9);
    }
  });
});
