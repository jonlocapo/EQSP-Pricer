import { describe, expect, it } from 'vitest';
import { riskNeutralDrift } from '../src/model/market';
import type { MarketData } from '../src/model/market';
import { bsCall } from '../src/engine/blackScholes';
import { makeDf } from '../src/engine/discount';
import { runMc } from '../src/engine/mc';
import type { PathOutcome, PayoffEvaluator } from '../src/engine/payoffs/types';
import { executePriceRequest } from '../src/worker/pricing';
import type { PricingHooks } from '../src/worker/pricing';
import type { ParticipationSpec } from '../src/model/product';
import type { PriceRequest } from '../src/model/request';

describe('riskNeutralDrift', () => {
  const base: MarketData = { spot: 100, vol: 0.25, rate: 0.02, divYield: 0.01, currency: 'EUR' };

  it('reduces to rate - divYield when no quanto params are set', () => {
    expect(riskNeutralDrift(base)).toBeCloseTo(base.rate - base.divYield, 12);
  });

  it('uses rUnd - q - rho*sigma*sigmaFx when quanto params are set', () => {
    const m: MarketData = {
      ...base,
      quanto: { rateUnderlying: 0.05, fxVol: 0.12, corrEqFx: 0.4 },
    };
    const expected = 0.05 - base.divYield - 0.4 * base.vol * 0.12;
    expect(riskNeutralDrift(m)).toBeCloseTo(expected, 12);
  });

  it('rho=0 reduces the quanto drift to rUnd - q', () => {
    const m: MarketData = {
      ...base,
      quanto: { rateUnderlying: 0.05, fxVol: 0.12, corrEqFx: 0 },
    };
    expect(riskNeutralDrift(m)).toBeCloseTo(0.05 - base.divYield, 12);
  });

  it('negative correlation raises drift relative to rho=0', () => {
    const zero: MarketData = { ...base, quanto: { rateUnderlying: 0.05, fxVol: 0.12, corrEqFx: 0 } };
    const neg: MarketData = { ...base, quanto: { rateUnderlying: 0.05, fxVol: 0.12, corrEqFx: -0.4 } };
    expect(riskNeutralDrift(neg)).toBeGreaterThan(riskNeutralDrift(zero));
  });
});

describe('MC forward under quanto drift', () => {
  const market: MarketData = {
    spot: 100,
    vol: 0.25,
    rate: 0.02,
    divYield: 0.01,
    currency: 'USD',
    quanto: { rateUnderlying: 0.05, fxVol: 0.12, corrEqFx: 0.4 },
  };
  const s0 = 100;
  const t = 1;
  const nSteps = 252;
  const dtYears = t / nSteps;
  const numPaths = 200_000;
  const seed = 777;

  it('E[S_T/S0]*df(T)*100 matches the closed-form quanto forward', () => {
    const df = makeDf(market.rate);
    const evaluator: PayoffEvaluator = (spots: Float64Array): PathOutcome => {
      const perf = spots[spots.length - 1] / s0;
      return { pvPct: perf * 100 * df(t), lifeYears: t };
    };
    const result = runMc({ numPaths, seed, antithetic: true, nSteps, dtYears, s0, market, evaluator });

    const mu = riskNeutralDrift(market);
    const expected = 100 * Math.exp(mu * t) * Math.exp(-market.rate * t);
    const tol = Math.max(3 * result.stderrPct, 0.15);
    expect(Math.abs(result.pvPct - expected)).toBeLessThan(tol);
  });
});

describe('Quanto vanilla call vs Black-Scholes with adjusted carry', () => {
  const market: MarketData = {
    spot: 100,
    vol: 0.25,
    rate: 0.02,
    divYield: 0.01,
    currency: 'USD',
    quanto: { rateUnderlying: 0.05, fxVol: 0.12, corrEqFx: 0.4 },
  };
  const s0 = 100;
  const k = 100;
  const t = 1;
  const nSteps = 252;
  const dtYears = t / nSteps;
  const numPaths = 200_000;
  const seed = 2024;

  it('prices within tolerance of bsCall using carry b = mu (q_eff = rate - mu)', () => {
    const df = makeDf(market.rate);
    const evaluator: PayoffEvaluator = (spots: Float64Array): PathOutcome => {
      const sT = spots[spots.length - 1];
      const intrinsic = Math.max(sT - k, 0);
      return { pvPct: ((intrinsic / s0) * 100) * df(t), lifeYears: t };
    };
    const result = runMc({ numPaths, seed, antithetic: true, nSteps, dtYears, s0, market, evaluator });

    const mu = riskNeutralDrift(market);
    const qEff = market.rate - mu;
    const bsPrice = (bsCall(s0, k, t, market.vol, market.rate, qEff) / s0) * 100;
    const tol = Math.max(3 * result.stderrPct, 0.2);
    expect(Math.abs(result.pvPct - bsPrice)).toBeLessThan(tol);
  });
});

describe('executePriceRequest with quanto market', () => {
  const hooks: PricingHooks = {
    onProgress: () => {},
    isCancelled: () => false,
    yieldNow: () => Promise.resolve(),
  };

  const marketNoQuanto: MarketData = { spot: 100, vol: 0.25, rate: 0.02, divYield: 0.02, currency: 'EUR' };
  // Isolate the rho*sigma*sigmaFx drag: keep rateUnderlying == note rate so the
  // only difference from marketNoQuanto's drift is the quanto correlation term.
  const marketQuanto: MarketData = {
    ...marketNoQuanto,
    currency: 'USD',
    quanto: { rateUnderlying: marketNoQuanto.rate, fxVol: 0.12, corrEqFx: 0.4 },
  };

  const capGuar: ParticipationSpec = {
    kind: 'participation',
    underlyings: [{ name: 'TEST' }],
    currency: 'EUR',
    notional: 1_000_000,
    tenorYears: 1,
    reofferPct: 100,
    issuePricePct: 100,
    upside: { strikePct: 100, participationPct: 150, variant: { variant: 'vanilla' } },
    downside: { strikePct: 100, leveragePct: 0, barrierType: 'none', kiBarrierPct: 60, twinWinPct: 0 },
    bonusPct: 0,
    protectionPct: 100,
  };

  function req(market: MarketData): PriceRequest {
    return {
      id: 't',
      product: capGuar,
      market,
      mc: { numPaths: 100_000, seed: 42, antithetic: true },
      solve: { kind: 'none' },
      greeks: false,
    };
  }

  it('runs with quanto set and produces a lower PV than without quanto (positive rho lowers the upside-heavy forward)', async () => {
    const withQuanto = await executePriceRequest(req(marketQuanto), hooks);
    const withoutQuanto = await executePriceRequest(req(marketNoQuanto), hooks);

    expect(withQuanto).not.toBeNull();
    expect(withoutQuanto).not.toBeNull();
    expect(Number.isFinite(withQuanto!.pvPct)).toBe(true);
    expect(Number.isFinite(withoutQuanto!.pvPct)).toBe(true);

    // With rateUnderlying held equal to the note rate, the only difference
    // in drift is the -rho*sigma*sigmaFx term (mu_quanto = rate - q - 1.2%
    // vs mu_plain = rate - q). Positive rho lowers drift, so this
    // upside-participation note is worth strictly less under quanto.
    expect(withQuanto!.pvPct).toBeLessThan(withoutQuanto!.pvPct);
  });
});
