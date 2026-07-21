import { describe, expect, it } from 'vitest';
import type { CouponProductSpec, ParticipationSpec } from '../src/model/product';
import type { EvaluatorContext, PathOutcome } from '../src/engine/payoffs/types';
import { buildGrid } from '../src/engine/schedule';
import { makeDf } from '../src/engine/discount';
import { PathBatchGenerator } from '../src/engine/gbm';
import {
  makeCouponEvaluator,
  makeCouponObservables,
  makeCouponOutcome,
} from '../src/engine/payoffs/couponProducts';
import {
  makeParticipationEvaluator,
  makeParticipationObservables,
  makeParticipationOutcome,
} from '../src/engine/payoffs/participation';

/**
 * CORRECTNESS GATE for the observables cache refactor: proves, BEFORE any
 * caching is wired up, that `phaseB(phaseA(path)) === monolithicEvaluator(path)`
 * for a sample of concrete GBM paths across a spread of coupon and
 * participation spec variants. If this test fails, the split itself is
 * wrong and no amount of caching machinery on top of it can be correct.
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

function expectOutcomesEqual(a: PathOutcome, b: PathOutcome) {
  expect(b.pvPct).toBe(a.pvPct);
  expect(b.calledAtPeriod).toBe(a.calledAtPeriod);
  expect(b.kiEvent).toBe(a.kiEvent);
  expect(b.upsideKoEvent).toBe(a.upsideKoEvent);
  expect(b.koEvent).toBe(a.koEvent);
  expect(b.lifeYears).toBe(a.lifeYears);
}

describe('observables split — phaseB(phaseA(path)) === monolithic evaluator', () => {
  const couponSpecs: { name: string; spec: CouponProductSpec }[] = [
    { name: 'european KI, conditional coupon', spec: baseCoupon() },
    { name: 'american KI, conditional coupon', spec: baseCoupon({ barrierType: 'american' }) },
    { name: 'no KI barrier (plain RC)', spec: baseCoupon({ barrierType: 'none' }) },
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
    { name: 'no call feature', spec: baseCoupon({ callType: 'none' }) },
    { name: 'gearing downside 150, low ki', spec: baseCoupon({ downsideLeveragePct: 150, kiBarrierPct: 50 }) },
  ];

  const participationSpecs: { name: string; spec: ParticipationSpec }[] = [
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
      name: 'twin-win, KI european, not knocked in path family',
      spec: baseParticipation({
        downside: { strikePct: 100, leveragePct: 100, barrierType: 'european', kiBarrierPct: 40, twinWinPct: 50 },
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

  const nSteps = 504; // 2y * 252
  const nPaths = 50;
  const pathSets = [
    samplePaths(nPaths, nSteps, 100, 1),
    samplePaths(nPaths, nSteps, 100, 999), // independent seed for path-shape diversity
  ];

  for (const { name, spec } of couponSpecs) {
    it(`coupon: ${name}`, () => {
      const grid = buildGrid(spec);
      const ctx: EvaluatorContext = { market, grid, df: makeDf(market.rate) };
      const monolithic = makeCouponEvaluator(spec, ctx);
      const phaseA = makeCouponObservables(ctx);
      const phaseB = makeCouponOutcome(spec, ctx);

      for (const paths of pathSets) {
        for (const p of paths) {
          const expected = monolithic(p);
          const actual = phaseB(phaseA(p));
          expectOutcomesEqual(expected, actual);
        }
      }
    });
  }

  for (const { name, spec } of participationSpecs) {
    it(`participation: ${name}`, () => {
      const grid = buildGrid(spec);
      const ctx: EvaluatorContext = { market, grid, df: makeDf(market.rate) };
      const monolithic = makeParticipationEvaluator(spec, ctx);
      const phaseA = makeParticipationObservables();
      const phaseB = makeParticipationOutcome(spec, ctx);

      for (const paths of pathSets) {
        for (const p of paths) {
          const expected = monolithic(p);
          const actual = phaseB(phaseA(p));
          expectOutcomesEqual(expected, actual);
        }
      }
    });
  }
});
