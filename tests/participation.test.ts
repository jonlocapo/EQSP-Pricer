import { describe, expect, it } from 'vitest';
import type { ParticipationSpec } from '../src/model/product';
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

/** Generic participation spec builder. Defaults: booster-shaped (barrier none). */
function spec(overrides: Partial<ParticipationSpec> = {}): ParticipationSpec {
  return {
    kind: 'participation',
    ...baseCommon(),
    upside: { strikePct: 100, participationPct: 150, variant: { variant: 'vanilla' } },
    downside: { strikePct: 100, leveragePct: 100, barrierType: 'none', kiBarrierPct: 60, twinWinPct: 0 },
    bonusPct: 0,
    protectionPct: 0,
    ...overrides,
  };
}

describe('participation - booster-style geared upside (barrier none)', () => {
  it('participation 150, strike 100, no barrier: perf 1.2 -> 130', () => {
    const ev = makeParticipationEvaluator(spec(), ctx());
    const out = ev(path(100, 110, 120));
    // upside = 1.5*(1.2-1)*100 = 30; barrierType none -> else-branch always;
    // loss = 1.0*max(0,100-120) = 0 -> red = 100+30-0 = 130
    expect(out.pvPct).toBeCloseTo(130, 10);
    expect(out.kiEvent).toBeUndefined();
  });

  it('participation 150, strike 100, no barrier: perf 0.8 -> 80 (leverage 100, downside strike 100)', () => {
    const ev = makeParticipationEvaluator(spec(), ctx());
    const out = ev(path(100, 90, 80));
    // upside = 0 (perf<1); loss = 1.0*max(0,100-80) = 20 -> red = 100+0-20 = 80
    expect(out.pvPct).toBeCloseTo(80, 10);
  });
});

describe('participation - upside variants', () => {
  it('call spread cap: upper 120, participation 150: perf 1.5 -> 130', () => {
    const ev = makeParticipationEvaluator(
      spec({ upside: { strikePct: 100, participationPct: 150, variant: { variant: 'callSpread', upperStrikePct: 120 } } }),
      ctx(),
    );
    const out = ev(path(100, 130, 150));
    // effPerf = min(1.5,1.2) = 1.2; upside = 1.5*(1.2-1)*100 = 30 -> red = 130 - 0 loss
    expect(out.pvPct).toBeCloseTo(130, 10);
  });

  it('koRebate american, barrier 130, rebate 5: touched intraperiod -> rebate replaces upside', () => {
    const ev = makeParticipationEvaluator(
      spec({
        upside: {
          strikePct: 100,
          participationPct: 150,
          variant: { variant: 'koRebate', koBarrierPct: 130, koMonitoring: 'american', rebatePct: 5 },
        },
      }),
      ctx(),
    );
    const out = ev(path(100, 135, 140));
    // touched 130 intraperiod -> KO'd; upside leg = rebate 5 (not regeared);
    // downside: barrier none, perf 1.4 -> loss 0 -> red = 100+5-0 = 105
    expect(out.pvPct).toBeCloseTo(105, 10);
    expect(out.upsideKoEvent).toBe(true);
  });

  it('koRebate european, barrier 130, rebate 5: touched intraperiod but final < barrier -> NOT KO', () => {
    const ev = makeParticipationEvaluator(
      spec({
        upside: {
          strikePct: 100,
          participationPct: 150,
          variant: { variant: 'koRebate', koBarrierPct: 130, koMonitoring: 'european', rebatePct: 5 },
        },
      }),
      ctx(),
    );
    const out = ev(path(100, 135, 120));
    // European only checks perf_T = 1.2 < 1.3 -> not KO'd; normal gearing:
    // upside = 1.5*(1.2-1)*100 = 30; loss = max(0,100-120) = 0 -> red = 130
    expect(out.pvPct).toBeCloseTo(130, 10);
    expect(out.upsideKoEvent).toBe(false);
  });

  it('koRebate european, barrier 130, rebate 5: final >= barrier -> KO', () => {
    const ev = makeParticipationEvaluator(
      spec({
        upside: {
          strikePct: 100,
          participationPct: 150,
          variant: { variant: 'koRebate', koBarrierPct: 130, koMonitoring: 'european', rebatePct: 5 },
        },
      }),
      ctx(),
    );
    const out = ev(path(100, 110, 140));
    // perf_T = 1.4 >= 1.3 -> KO'd; upside leg = rebate 5; loss 0 -> red = 105
    expect(out.pvPct).toBeCloseTo(105, 10);
    expect(out.upsideKoEvent).toBe(true);
  });
});

describe('participation - KI downside', () => {
  it("KI'd 1:1 downside (lev 100, strike 100): perf_T 0.9 after dip to 0.6 -> 90", () => {
    const ev = makeParticipationEvaluator(
      spec({
        upside: { strikePct: 100, participationPct: 100, variant: { variant: 'vanilla' } },
        downside: { strikePct: 100, leveragePct: 100, barrierType: 'american', kiBarrierPct: 70, twinWinPct: 0 },
      }),
      ctx(),
    );
    const out = ev(path(100, 60, 90));
    // minPerf 0.6 < 0.7 -> KI; upside = 0 (perf<1); loss = 1.0*max(0,100-90) = 10 -> red = 90
    expect(out.pvPct).toBeCloseTo(90, 10);
    expect(out.kiEvent).toBe(true);
  });

  it('raw-shortfall leverage: lev 125, strike 80, perf 0 -> red 0 (upside 0)', () => {
    const ev = makeParticipationEvaluator(
      spec({
        upside: { strikePct: 100, participationPct: 100, variant: { variant: 'vanilla' } },
        downside: { strikePct: 80, leveragePct: 125, barrierType: 'none', kiBarrierPct: 60, twinWinPct: 0 },
      }),
      ctx(),
    );
    const out = ev(path(100, 50, 0));
    // barrier none -> always in loss branch; upside = 0;
    // loss = 1.25*max(0, 80-0) = 100 -> red = max(100+0-100, 0, 0) = 0
    expect(out.pvPct).toBeCloseTo(0, 10);
  });

  it('put-spread floor: lower 50, downside strike 100, leverage 100, perf 0.3 -> 50 floor', () => {
    const ev = makeParticipationEvaluator(
      spec({
        upside: { strikePct: 100, participationPct: 100, variant: { variant: 'vanilla' } },
        downside: {
          strikePct: 100,
          leveragePct: 100,
          barrierType: 'none',
          kiBarrierPct: 60,
          twinWinPct: 0,
          putSpread: { lowerStrikePct: 50 },
        },
      }),
      ctx(),
    );
    const out = ev(path(100, 60, 30));
    // floored perf = max(0.3, 0.5) = 0.5; loss = 1.0*(100-50) = 50 -> red = 100-50 = 50
    expect(out.pvPct).toBeCloseTo(50, 10);
  });
});

describe('participation - twin-win downside', () => {
  function twinSpec(overrides: Partial<ParticipationSpec> = {}): ParticipationSpec {
    return spec({
      upside: { strikePct: 100, participationPct: 100, variant: { variant: 'vanilla' } },
      downside: { strikePct: 100, leveragePct: 100, barrierType: 'american', kiBarrierPct: 60, twinWinPct: 100 },
      ...overrides,
    });
  }

  it('no KI, perf 0.8 -> 120 (downside participation flips to a gain)', () => {
    const ev = makeParticipationEvaluator(twinSpec(), ctx());
    const out = ev(path(100, 90, 80));
    // not KI'd (min perf 0.8 >= 0.6); upside = 0; twinWin = 1.0*max(0,1-0.8)*100 = 20
    // red = max(100+0, 100+0+20) = 120
    expect(out.pvPct).toBeCloseTo(120, 10);
    expect(out.kiEvent).toBe(false);
  });

  it("KI'd, perf_T 0.7 -> 70 (1:1 loss after KI, twin-win lost)", () => {
    const ev = makeParticipationEvaluator(twinSpec(), ctx());
    const out = ev(path(100, 55, 70));
    // KI (min perf 0.55 < 0.6); upside = 0; loss = 1.0*max(0,100-70) = 30 -> red = 70
    expect(out.pvPct).toBeCloseTo(70, 10);
    expect(out.kiEvent).toBe(true);
  });
});

describe('participation - bonus floor', () => {
  function bonusSpec(bonusPct: number): ParticipationSpec {
    return spec({
      upside: { strikePct: 100, participationPct: 100, variant: { variant: 'vanilla' } },
      downside: { strikePct: 100, leveragePct: 100, barrierType: 'american', kiBarrierPct: 60, twinWinPct: 0 },
      bonusPct,
    });
  }

  it('bonus 15 beats a small upside (8): no KI, perf 1.08 -> 115', () => {
    const ev = makeParticipationEvaluator(bonusSpec(15), ctx());
    const out = ev(path(100, 104, 108));
    // not KI'd; upside = 1.0*(1.08-1)*100 = 8; red = max(115, 108) = 115
    expect(out.pvPct).toBeCloseTo(115, 10);
    expect(out.kiEvent).toBe(false);
  });

  it('bonus 15 loses to a big upside (30): no KI, perf 1.3 -> 130', () => {
    const ev = makeParticipationEvaluator(bonusSpec(15), ctx());
    const out = ev(path(100, 115, 130));
    // not KI'd; upside = 30; red = max(115, 130) = 130
    expect(out.pvPct).toBeCloseTo(130, 10);
  });

  it('bonus 15 is lost on KI: perf_T 0.9 after dip to 0.55 -> 90', () => {
    const ev = makeParticipationEvaluator(bonusSpec(15), ctx());
    const out = ev(path(100, 55, 90));
    // KI (min perf 0.55 < 0.6); upside = 0; loss = 1.0*max(0,100-90) = 10 -> red = 90 (bonus not applied)
    expect(out.pvPct).toBeCloseTo(90, 10);
    expect(out.kiEvent).toBe(true);
  });
});

describe('participation - capital guaranteed identity', () => {
  function capGuarSpec(): ParticipationSpec {
    return spec({
      upside: { strikePct: 100, participationPct: 100, variant: { variant: 'vanilla' } },
      downside: { strikePct: 100, leveragePct: 0, barrierType: 'none', kiBarrierPct: 60, twinWinPct: 0 },
      bonusPct: 0,
      protectionPct: 100,
    });
  }

  it('protection 100, downside lev 0: perf 1.4 -> red = max(100, 100+upside) = 140', () => {
    const ev = makeParticipationEvaluator(capGuarSpec(), ctx());
    const out = ev(path(100, 120, 140));
    // barrier none -> else-branch; upside = 40; loss = 0*max(...) = 0 -> 140; floor 100 -> 140
    expect(out.pvPct).toBeCloseTo(140, 10);
  });

  it('protection 100, downside lev 0: perf 0.5 -> red = max(100, 100+0) = 100 (floor)', () => {
    const ev = makeParticipationEvaluator(capGuarSpec(), ctx());
    const out = ev(path(100, 70, 50));
    // upside = 0; loss = 0 -> 100; floor 100 -> 100
    expect(out.pvPct).toBeCloseTo(100, 10);
  });
});

describe('participation - discounting', () => {
  it('rate > 0: discounting applied via df', () => {
    const s = spec({
      upside: { strikePct: 100, participationPct: 100, variant: { variant: 'vanilla' } },
      downside: { strikePct: 100, leveragePct: 100, barrierType: 'american', kiBarrierPct: 60, twinWinPct: 100 },
    });
    const c = ctx(0.03);
    const ev = makeParticipationEvaluator(s, c);
    const out = ev(path(100, 115, 130));
    // no KI; upside = 30; twinWin = 0 (perf > dnStrike) -> red = 130; discounted
    const expected = 130 * Math.exp(-0.03 * 1);
    expect(out.pvPct).toBeCloseTo(expected, 10);
  });
});
