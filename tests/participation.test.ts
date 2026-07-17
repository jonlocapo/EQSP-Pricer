import { describe, expect, it } from 'vitest';
import type {
  BonusSpec,
  BoosterSpec,
  CapitalGuaranteedSpec,
  TwinWinSpec,
} from '../src/model/product';
import type { EvaluatorContext, PricingGrid } from '../src/engine/payoffs/types';
import { makeParticipationEvaluator } from '../src/engine/payoffs/participation';

// Small grid, terminal observation only (2 daily steps for KI/KO monitoring tests).
const grid: PricingGrid = {
  nSteps: 2,
  dtYears: 0.5,
  tenorYears: 1,
  couponObs: [],
  callObs: [],
  settlementObs: [],
};

function ctx(rate = 0): EvaluatorContext {
  return {
    market: { spot: 100, vol: 0.2, rate, divYield: 0, currency: 'EUR' },
    grid,
    df: (t: number) => Math.exp(-rate * t),
  };
}

function path(...vals: number[]): Float64Array {
  return new Float64Array(vals);
}

function baseCommon() {
  return {
    underlyings: [{ name: 'TEST' }],
    currency: 'EUR',
    notional: 1_000_000,
    tenorYears: 1,
    reofferPct: 100,
    issuePricePct: 100,
  };
}

describe('participation - booster', () => {
  function booster(overrides: Partial<BoosterSpec> = {}): BoosterSpec {
    return {
      kind: 'participation',
      subtype: 'booster',
      upside: { variant: 'vanilla' },
      strikePct: 100,
      gearingPct: 150,
      downsideStrikePct: 100,
      downsideLeveragePct: 100,
      barrierType: 'none',
      kiBarrierPct: 70,
      ...baseCommon(),
      ...overrides,
    };
  }

  it('gearing 150, strike 100, no barrier: perf 1.2 -> 130', () => {
    const ev = makeParticipationEvaluator(booster(), ctx());
    const out = ev(path(100, 110, 120));
    // upside = 1.5*(1.2-1)*100 = 30 -> 130; barrierType none -> downside always exposed but perf>=downsideStrike -> 0 loss
    expect(out.pvPct).toBeCloseTo(130, 10);
  });

  it('gearing 150, strike 100, no barrier: perf 0.8 -> 80 (leverage 100, downside strike 100)', () => {
    const ev = makeParticipationEvaluator(booster(), ctx());
    const out = ev(path(100, 90, 80));
    // loss = 1.0*(1.0-0.8)*100 = 20 -> 100-20 = 80
    expect(out.pvPct).toBeCloseTo(80, 10);
  });

  it('european KI 70, perf 0.8 (no dip below 70) -> 100 (protected)', () => {
    const ev = makeParticipationEvaluator(booster({ barrierType: 'european', kiBarrierPct: 70 }), ctx());
    const out = ev(path(100, 90, 80));
    // perf_T=0.8 >= 0.70 -> not KI -> downside protected (0); upside: perf 0.8 < strike 1 -> 0
    expect(out.pvPct).toBeCloseTo(100, 10);
    expect(out.kiEvent).toBe(false);
  });

  it('european KI 70, perf 0.65 (knocked in) -> 65', () => {
    const ev = makeParticipationEvaluator(booster({ barrierType: 'european', kiBarrierPct: 70 }), ctx());
    const out = ev(path(100, 90, 65));
    // perf_T=0.65 < 0.70 -> KI; loss = 1.0*(1.0-0.65)*100 = 35 -> 65
    expect(out.pvPct).toBeCloseTo(65, 10);
    expect(out.kiEvent).toBe(true);
  });

  it('callSpread upper 120: perf 1.5 -> 130', () => {
    const ev = makeParticipationEvaluator(
      booster({ upside: { variant: 'callSpread', upperStrikePct: 120 } }),
      ctx(),
    );
    const out = ev(path(100, 130, 150));
    // effPerf = min(1.5, 1.2) = 1.2; upside = 1.5*(1.2-1)*100 = 30 -> 130
    expect(out.pvPct).toBeCloseTo(130, 10);
  });

  it('koRebate barrier 130 american, rebate 5: touched -> rebate replaces upside', () => {
    const ev = makeParticipationEvaluator(
      booster({
        upside: { variant: 'koRebate', koBarrierPct: 130, koMonitoring: 'american', rebatePct: 5 },
      }),
      ctx(),
    );
    const out = ev(path(100, 135, 140));
    // touched 130 intraperiod (spot 135) -> KO'd; upside leg = rebate 5; perf_T=1.4>=downsideStrike -> no loss
    expect(out.pvPct).toBeCloseTo(105, 10);
    expect(out.upsideKoEvent).toBe(true);
  });

  it('koRebate barrier 130 american, rebate 5: not touched -> normal gearing', () => {
    const ev = makeParticipationEvaluator(
      booster({
        upside: { variant: 'koRebate', koBarrierPct: 130, koMonitoring: 'american', rebatePct: 5 },
      }),
      ctx(),
    );
    const out = ev(path(100, 110, 120));
    // never reaches 130 -> not KO'd; upside = 1.5*(1.2-1)*100 = 30 -> 130
    expect(out.pvPct).toBeCloseTo(130, 10);
    expect(out.upsideKoEvent).toBe(false);
  });

  it('put spread lower 50, downside strike 100, leverage 100, perf 0.3 -> 50 floor', () => {
    const ev = makeParticipationEvaluator(
      booster({ downsidePutSpread: { lowerStrikePct: 50 } }),
      ctx(),
    );
    const out = ev(path(100, 60, 30));
    // floored perf = max(0.3, 0.5) = 0.5; loss = 1.0*(1.0-0.5)*100 = 50 -> 100-50 = 50
    expect(out.pvPct).toBeCloseTo(50, 10);
  });
});

describe('participation - bonus', () => {
  function bonus(overrides: Partial<BonusSpec> = {}): BonusSpec {
    return {
      kind: 'participation',
      subtype: 'bonus',
      upside: { variant: 'vanilla' },
      bonusLevelPct: 115,
      barrierType: 'american',
      kiBarrierPct: 65,
      ...baseCommon(),
      ...overrides,
    };
  }

  it('no dip, perf 0.9 -> 115 (bonus floor)', () => {
    const ev = makeParticipationEvaluator(bonus(), ctx());
    const out = ev(path(100, 95, 90));
    // no KI: red = max(115, 100+(0.9-1)*100) = max(115, 90) = 115
    expect(out.pvPct).toBeCloseTo(115, 10);
    expect(out.kiEvent).toBe(false);
  });

  it('no dip, perf 1.3 -> 130 (upside exceeds bonus)', () => {
    const ev = makeParticipationEvaluator(bonus(), ctx());
    const out = ev(path(100, 115, 130));
    // no KI: red = max(115, 100+(1.3-1)*100) = max(115, 130) = 130
    expect(out.pvPct).toBeCloseTo(130, 10);
  });

  it('dip below 65, perf_T 0.9 -> 90 (1:1 downside, bonus lost)', () => {
    const ev = makeParticipationEvaluator(bonus(), ctx());
    const out = ev(path(100, 60, 90));
    // KI (dip to 0.6 < 0.65); red = min(100*0.9, 100+(0.9-1)*100) = min(90,90) = 90
    expect(out.pvPct).toBeCloseTo(90, 10);
    expect(out.kiEvent).toBe(true);
  });

  it('dip below 65, perf_T 1.3 -> 130 (upside still applies after KI)', () => {
    const ev = makeParticipationEvaluator(bonus(), ctx());
    const out = ev(path(100, 60, 130));
    // KI; red = min(100*1.3, 100+(1.3-1)*100) = min(130,130) = 130
    expect(out.pvPct).toBeCloseTo(130, 10);
    expect(out.kiEvent).toBe(true);
  });
});

describe('participation - capitalGuaranteed', () => {
  function capGuar(overrides: Partial<CapitalGuaranteedSpec> = {}): CapitalGuaranteedSpec {
    return {
      kind: 'participation',
      subtype: 'capitalGuaranteed',
      upside: { variant: 'vanilla' },
      protectionPct: 90,
      strikePct: 100,
      participationPct: 50,
      ...baseCommon(),
      ...overrides,
    };
  }

  it('protection 90, participation 50, strike 100: perf 1.4 -> 110', () => {
    const ev = makeParticipationEvaluator(capGuar(), ctx());
    const out = ev(path(100, 120, 140));
    // upsideRaw = max(0,1.4-1)*100 = 40; leg = 0.5*40 = 20; red = max(90, 110) = 110
    expect(out.pvPct).toBeCloseTo(110, 10);
  });

  it('protection 90, participation 50, strike 100: perf 0.5 -> 90 (floor)', () => {
    const ev = makeParticipationEvaluator(capGuar(), ctx());
    const out = ev(path(100, 70, 50));
    // upsideRaw = 0; red = max(90, 90) = 90
    expect(out.pvPct).toBeCloseTo(90, 10);
  });

  it('cap via callSpread upper 120: perf 1.4 -> 100', () => {
    const ev = makeParticipationEvaluator(
      capGuar({ upside: { variant: 'callSpread', upperStrikePct: 120 } }),
      ctx(),
    );
    const out = ev(path(100, 120, 140));
    // effPerf = min(1.4,1.2) = 1.2; upsideRaw = 20; leg = 0.5*20 = 10; red = max(90, 100) = 100
    expect(out.pvPct).toBeCloseTo(100, 10);
  });
});

describe('participation - twinWin', () => {
  function twinWin(overrides: Partial<TwinWinSpec> = {}): TwinWinSpec {
    return {
      kind: 'participation',
      subtype: 'twinWin',
      upside: { variant: 'vanilla' },
      partUpPct: 100,
      partDownPct: 100,
      barrierType: 'american',
      kiBarrierPct: 60,
      ...baseCommon(),
      ...overrides,
    };
  }

  it('no dip, perf 0.8 -> 120 (downside participation flips to gain)', () => {
    const ev = makeParticipationEvaluator(twinWin(), ctx());
    const out = ev(path(100, 90, 80));
    // no KI: red = 100 + 1.0*max(0,0.8-1)*100 + 1.0*max(0,1-0.8)*100 = 100+0+20 = 120
    expect(out.pvPct).toBeCloseTo(120, 10);
    expect(out.kiEvent).toBe(false);
  });

  it('no dip, perf 1.3 -> 130', () => {
    const ev = makeParticipationEvaluator(twinWin(), ctx());
    const out = ev(path(100, 115, 130));
    // no KI: red = 100 + 1.0*max(0,1.3-1)*100 + 0 = 130
    expect(out.pvPct).toBeCloseTo(130, 10);
  });

  it('dip below 60, perf_T 0.7 -> 70 (1:1 downside after KI)', () => {
    const ev = makeParticipationEvaluator(twinWin(), ctx());
    const out = ev(path(100, 55, 70));
    // KI (dip to 0.55 < 0.60); red = min(100*0.7, 100+1.0*max(0,0.7-1)*100) = min(70,100) = 70
    expect(out.pvPct).toBeCloseTo(70, 10);
    expect(out.kiEvent).toBe(true);
  });

  it('dip below 60, perf_T 1.2 -> 120', () => {
    const ev = makeParticipationEvaluator(twinWin(), ctx());
    const out = ev(path(100, 55, 120));
    // KI; red = min(100*1.2, 100+1.0*max(0,1.2-1)*100) = min(120,120) = 120
    expect(out.pvPct).toBeCloseTo(120, 10);
    expect(out.kiEvent).toBe(true);
  });

  it('rate > 0: discounting applied via df', () => {
    const spec = twinWin();
    const c = ctx(0.03);
    const ev = makeParticipationEvaluator(spec, c);
    const out = ev(path(100, 115, 130));
    const expected = 130 * Math.exp(-0.03 * 1);
    expect(out.pvPct).toBeCloseTo(expected, 10);
  });
});
