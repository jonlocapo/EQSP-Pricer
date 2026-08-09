import { describe, expect, it } from 'vitest';
import type { CouponProductSpec, ParticipationSpec } from '../src/model/product';
import type { LabSpec } from '../src/model/lab';
import { LAB_PRESETS } from '../src/model/lab';
import type { EvaluatorContext, PathOutcome } from '../src/engine/payoffs/types';
import { buildGrid } from '../src/engine/schedule';
import { makeDf } from '../src/engine/discount';
import { PathBatchGenerator } from '../src/engine/gbm';
import { compileContract } from '../src/engine/combinators/compile';
import { buildParticipation, buildReverseConvertible } from '../src/engine/combinators/products';
import { buildLabContract, labObservablesRequirements, validateLabSpec } from '../src/engine/combinators/lab';

/**
 * CORRECTNESS GATE for the Contract Lab combinator lowering
 * (src/engine/combinators/lab.ts, src/model/lab.ts). Mirrors
 * tests/combinators.test.ts's own equivalence-proof pattern: a Lab spec
 * assembled to mirror a hand-written product must compile to a Contract
 * that is bit-for-bit equal, per path, to that product's own Contract.
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

function expectOutcomesEqual(a: PathOutcome, b: PathOutcome) {
  expect(b.pvPct).toBe(a.pvPct);
  expect(b.calledAtPeriod).toBe(a.calledAtPeriod);
  expect(b.kiEvent).toBe(a.kiEvent);
  expect(b.upsideKoEvent).toBe(a.upsideKoEvent);
  expect(b.koEvent).toBe(a.koEvent);
  expect(b.lifeYears).toBe(a.lifeYears);
}

const nSteps = 504; // 2y * 252
const nPaths = 40;
const pathSets = [samplePaths(nPaths, nSteps, 100, 7), samplePaths(nPaths, nSteps, 100, 321)];

function findPreset(name: string): LabSpec {
  const preset = LAB_PRESETS.find((p) => p.name === name);
  if (!preset) throw new Error(`no such preset: ${name}`);
  return preset.build();
}

describe('Contract Lab — reverse convertible preset == buildReverseConvertible (per-path, exact)', () => {
  it('matches field by field across many paths', () => {
    const labSpec = findPreset('Reverse convertible');
    const [coupon, shortPut] = labSpec.blocks;
    if (coupon.t !== 'coupon' || shortPut.t !== 'shortPut') throw new Error('unexpected preset shape');

    const couponSpec: CouponProductSpec = {
      kind: 'coupon',
      underlyings: labSpec.underlyings,
      notional: labSpec.notional,
      tenorYears: labSpec.tenorYears,
      reofferPct: labSpec.reofferPct,
      issuePricePct: labSpec.issuePricePct,
      barrierType: shortPut.barrierType,
      kiBarrierPct: shortPut.kiBarrierPct,
      putStrikePct: shortPut.strikePct,
      downsideLeveragePct: shortPut.leveragePct,
      callType: 'none',
      callFrequency: 'quarterly',
      callFromPeriod: 1,
      callBarrierPct: 100,
      stepDownPct: 0,
      customCallBarriersPct: [],
      couponType: coupon.barrierPct === null ? 'fixed' : coupon.memory ? 'memory' : 'conditional',
      couponFrequency: coupon.frequency,
      couponBarrierPct: coupon.barrierPct ?? 0,
      couponPaPct: coupon.ratePaPct,
      acCouponType: 'none',
      acCouponPct: 0,
    };

    const grid = buildGrid(couponSpec);
    const ctx: EvaluatorContext = { market, grid, df: makeDf(market.rate) };
    const oracleContract = buildReverseConvertible(couponSpec, grid);
    const oracle = compileContract(oracleContract, ctx);
    const labContract = buildLabContract(labSpec, grid);
    const compiled = compileContract(labContract, ctx);

    let count = 0;
    for (const paths of pathSets) {
      for (const p of paths) {
        const expected = oracle.outcome(oracle.observables(p));
        const actual = compiled.outcome(compiled.observables(p));
        expectOutcomesEqual(expected, actual);
        count++;
      }
    }
    expect(count).toBe(pathSets.length * nPaths);
  });
});

describe('Contract Lab — booster preset == buildParticipation/buildParticipationBooster (per-path, exact)', () => {
  it('matches field by field across many paths', () => {
    const labSpec = findPreset('Booster');
    const [upside, shortPut] = labSpec.blocks;
    if (upside.t !== 'upside' || shortPut.t !== 'shortPut') throw new Error('unexpected preset shape');

    const participationSpec: ParticipationSpec = {
      kind: 'participation',
      underlyings: labSpec.underlyings,
      notional: labSpec.notional,
      tenorYears: labSpec.tenorYears,
      reofferPct: labSpec.reofferPct,
      issuePricePct: labSpec.issuePricePct,
      upside: { strikePct: upside.strikePct, participationPct: upside.participationPct, variant: { variant: 'vanilla' } },
      downside: {
        strikePct: shortPut.strikePct,
        leveragePct: shortPut.leveragePct,
        barrierType: shortPut.barrierType,
        kiBarrierPct: shortPut.kiBarrierPct,
        twinWinPct: 0,
      },
      bonusPct: 0,
      protectionPct: 0,
    };

    const grid = buildGrid(participationSpec);
    const ctx: EvaluatorContext = { market, grid, df: makeDf(market.rate) };
    const oracleContract = buildParticipation(participationSpec, grid);
    const oracle = compileContract(oracleContract, ctx);
    const labContract = buildLabContract(labSpec, grid);
    const compiled = compileContract(labContract, ctx);

    for (const paths of pathSets) {
      for (const p of paths) {
        const expected = oracle.outcome(oracle.observables(p));
        const actual = compiled.outcome(compiled.observables(p));
        expectOutcomesEqual(expected, actual);
      }
    }
  });
});

describe('Contract Lab — event merging', () => {
  function baseLabSpec(): LabSpec {
    return {
      kind: 'lab',
      underlyings: [{ name: 'TEST' }],
      notional: 1_000_000,
      tenorYears: 1,
      reofferPct: 100,
      issuePricePct: 100,
      blocks: [],
    };
  }

  it('a quarterly coupon block plus a semiannual autocall block merge into one ascending, deduplicated, obsIndex-lockstep schedule', () => {
    const spec = baseLabSpec();
    spec.blocks = [
      { t: 'coupon', id: 'c1', frequency: 'quarterly', ratePaPct: 8, barrierPct: null, memory: false },
      { t: 'autocall', id: 'a1', frequency: 'semiannual', fromPeriod: 1, barrierPct: 100, stepDownPct: 0, snowballPaPct: 0 },
    ];
    const grid = buildGrid(spec);
    const contract = buildLabContract(spec, grid);

    // Quarterly (4 dates/yr over 1y = 4) union semiannual (2/yr) = 4
    // distinct dates: the semiannual dates (0.5y, 1.0y) coincide with two of
    // the quarterly ones, so the merged schedule has 4 events, not 6.
    expect(contract.events.length).toBe(4);

    // Ascending by gridIndex.
    for (let i = 1; i < contract.events.length; i++) {
      expect(contract.events[i].gridIndex).toBeGreaterThan(contract.events[i - 1].gridIndex);
    }

    // Every event carries a coupon leg (quarterly touches every date this
    // tenor produces). Only the 2nd and 4th (the semiannual dates) also
    // carry an autocall leg.
    contract.events.forEach((e, i) => {
      expect(e.coupon).toBeDefined();
      if (i === 1 || i === 3) expect(e.autocall).toBeDefined();
      else expect(e.autocall).toBeUndefined();
    });

    // obsIndex is assigned in lockstep with the merged list: perfAt(i) in
    // event i's Expr tree must read eventPerf[i]. Exercise this indirectly
    // by pricing a couple of paths and checking the result is finite and
    // well-formed — a misaligned obsIndex would read the wrong perf and
    // either throw (index out of range against a shorter eventPerf) or
    // silently mismatch.
    const ctx: EvaluatorContext = { market, grid, df: makeDf(market.rate) };
    const compiled = compileContract(contract, ctx);
    for (const p of samplePaths(4, grid.nSteps, 100, 11)) {
      const outcome = compiled.outcome(compiled.observables(p));
      expect(Number.isFinite(outcome.pvPct)).toBe(true);
    }
  });
});

describe('Contract Lab — observablesRequirements', () => {
  function specWith(barrierType: 'none' | 'european' | 'american', kiBarrierPct: number): LabSpec {
    return {
      kind: 'lab',
      underlyings: [{ name: 'TEST' }],
      notional: 1_000_000,
      tenorYears: 1,
      reofferPct: 100,
      issuePricePct: 100,
      blocks: [{ t: 'shortPut', id: 'p1', strikePct: 100, leveragePct: 100, barrierType, kiBarrierPct }],
    };
  }

  it('two specs differing only in barrier LEVEL report the identical descriptor', () => {
    const a = labObservablesRequirements(specWith('american', 55));
    const b = labObservablesRequirements(specWith('american', 80));
    expect(b).toEqual(a);
  });

  it('a monitoring MODE change (european -> american) reports a different descriptor', () => {
    const european = labObservablesRequirements(specWith('european', 60));
    const american = labObservablesRequirements(specWith('american', 60));
    expect(american).not.toEqual(european);
    expect(european.needsMin).toBe(false);
    expect(american.needsMin).toBe(true);
  });
});

describe('Contract Lab — validation', () => {
  function baseLabSpec(blocks: LabSpec['blocks']): LabSpec {
    return {
      kind: 'lab',
      underlyings: [{ name: 'TEST' }],
      notional: 1_000_000,
      tenorYears: 1,
      reofferPct: 100,
      issuePricePct: 100,
      blocks,
    };
  }

  it('rejects an empty block list', () => {
    expect(() => validateLabSpec(baseLabSpec([]))).toThrow();
  });

  it('rejects a non-positive tenor', () => {
    const spec = baseLabSpec([{ t: 'protection', id: 'p', floorPct: 90 }]);
    spec.tenorYears = 0;
    expect(() => validateLabSpec(spec)).toThrow();
  });

  it('rejects a negative coupon rate', () => {
    const spec = baseLabSpec([{ t: 'coupon', id: 'c', frequency: 'quarterly', ratePaPct: -1, barrierPct: null, memory: false }]);
    expect(() => validateLabSpec(spec)).toThrow();
  });

  it('rejects an autocall fromPeriod below 1', () => {
    const spec = baseLabSpec([
      { t: 'autocall', id: 'a', frequency: 'quarterly', fromPeriod: 0, barrierPct: 100, stepDownPct: 0, snowballPaPct: 0 },
    ]);
    expect(() => validateLabSpec(spec)).toThrow();
  });

  it('rejects a non-positive shortPut strike', () => {
    const spec = baseLabSpec([{ t: 'shortPut', id: 's', strikePct: 0, leveragePct: 100, barrierType: 'none', kiBarrierPct: 60 }]);
    expect(() => validateLabSpec(spec)).toThrow();
  });

  it('two protection blocks with different floors is fine — the higher one wins', () => {
    const spec = baseLabSpec([
      { t: 'protection', id: 'p1', floorPct: 90 },
      { t: 'protection', id: 'p2', floorPct: 80 },
    ]);
    expect(() => validateLabSpec(spec)).not.toThrow();
  });
});
