/**
 * Pricing orchestration: grid + evaluator assembly, sliced Monte Carlo (so
 * the worker can yield to its event loop for cancellation), LSMC branch for
 * issuer callables, solve-for via bracketed Brent, and bump-and-reprice
 * Greeks. Pure of DOM/worker APIs so it is testable in node; the worker
 * supplies the hooks.
 */
import type { MarketData } from '../model/market';
import type {
  CouponProductSpec,
  ParticipationSpec,
  ProductSpec,
} from '../model/product';
import type { Diagnostics, PriceRequest, PriceResult, SolveTarget } from '../model/request';
import { buildGrid } from '../engine/schedule';
import { makeDf } from '../engine/discount';
import { runMc } from '../engine/mc';
import { priceIssuerCallable } from '../engine/lsmc';
import { makeEvaluator } from '../engine/payoffs';
import { makeCouponCashflowExtractor } from '../engine/payoffs/couponProducts';
import type { EvaluatorContext } from '../engine/payoffs/types';
import type { PricingPhase } from './protocol';

export interface PricingHooks {
  /** Called with cumulative progress. */
  onProgress: (pathsDone: number, pathsTotal: number, phase: PricingPhase, solveIteration?: number) => void;
  isCancelled: () => boolean;
  /** Yield to the event loop so cancel messages can arrive. */
  yieldNow: () => Promise<void>;
}

const SLICE_PATHS = 20_000;

interface CoreResult {
  pvPct: number;
  stderrPct: number;
  diagnostics: Diagnostics;
  cancelled: boolean;
}

/** One full MC (or LSMC) valuation of a spec, sliced for cancellability. */
async function priceOnce(
  spec: ProductSpec,
  market: MarketData,
  numPaths: number,
  seed: number,
  antithetic: boolean,
  hooks: PricingHooks,
  phase: PricingPhase,
  progressBase = 0,
  progressTotal?: number,
  solveIteration?: number,
): Promise<CoreResult> {
  const grid = buildGrid(spec);
  const ctx: EvaluatorContext = { market, grid, df: makeDf(market.rate) };

  if (spec.kind === 'coupon' && spec.callType === 'issuerCallable') {
    // LSMC runs in one synchronous shot (no mid-run cancellation in v1).
    hooks.onProgress(progressBase, progressTotal ?? numPaths, phase, solveIteration);
    const { extractor, redemptionCostPct } = makeCouponCashflowExtractor(spec, ctx);
    const res = priceIssuerCallable({
      numPaths,
      seed,
      nSteps: grid.nSteps,
      s0: market.spot,
      market,
      grid,
      cashflows: extractor,
      redemptionCostPct,
      callObs: grid.callObs,
      callFromPeriod: spec.callFromPeriod,
      dtYears: grid.dtYears,
    });
    hooks.onProgress(progressBase + numPaths, progressTotal ?? numPaths, phase, solveIteration);
    await hooks.yieldNow();
    return {
      pvPct: res.pvPct,
      stderrPct: res.stderrPct,
      cancelled: hooks.isCancelled(),
      diagnostics: {
        callProb: res.callProb,
        expectedLifeYears: res.expectedLifeYears,
      },
    };
  }

  const evaluator = makeEvaluator(spec, ctx);
  const nSlices = Math.max(1, Math.ceil(numPaths / SLICE_PATHS));
  const per = Math.ceil(numPaths / nSlices);

  let wSum = 0;
  let pvSum = 0;
  let varSum = 0; // Σ w² · stderr²
  let kiSum = 0;
  let upKoSum = 0;
  let koSum = 0;
  let lifeSum = 0;
  const callCounts: number[] = [];
  let cancelled = false;

  for (let s = 0; s < nSlices; s++) {
    if (hooks.isCancelled()) {
      cancelled = true;
      break;
    }
    const slicePaths = Math.min(per, numPaths - s * per);
    const res = runMc({
      numPaths: slicePaths,
      seed: seed + s * 7919,
      antithetic,
      nSteps: grid.nSteps,
      dtYears: grid.dtYears,
      s0: market.spot,
      market,
      evaluator,
      onBatch: () => !hooks.isCancelled(),
    });
    const w = slicePaths;
    wSum += w;
    pvSum += w * res.pvPct;
    varSum += w * w * res.stderrPct * res.stderrPct;
    const d = res.diagnostics;
    kiSum += w * (d.kiProb ?? 0);
    upKoSum += w * (d.upsideKoProb ?? 0);
    koSum += w * (d.koProb ?? 0);
    lifeSum += w * (d.expectedLifeYears ?? 0);
    (d.callProb ?? []).forEach((p, i) => {
      while (callCounts.length <= i) callCounts.push(0);
      callCounts[i] += w * p;
    });
    if (res.cancelled) {
      cancelled = true;
      break;
    }
    hooks.onProgress(progressBase + (s + 1) * per, progressTotal ?? numPaths, phase, solveIteration);
    await hooks.yieldNow();
  }

  const W = wSum > 0 ? wSum : 1;
  return {
    pvPct: pvSum / W,
    stderrPct: Math.sqrt(varSum) / W,
    cancelled,
    diagnostics: {
      callProb: callCounts.map((c) => c / W),
      kiProb: kiSum / W,
      upsideKoProb: upKoSum / W,
      koProb: koSum / W,
      expectedLifeYears: lifeSum / W,
    },
  };
}

/** Immutably applies a solve variable to the spec. */
export function applySolveValue(spec: ProductSpec, target: SolveTarget, x: number): ProductSpec {
  switch (target.kind) {
    case 'none':
    case 'upfront':
      return spec;
    case 'couponPa':
      return { ...(spec as CouponProductSpec), couponPaPct: x };
    case 'acCouponPa':
      return { ...(spec as CouponProductSpec), acCouponPct: x };
    case 'couponBarrier':
      return { ...(spec as CouponProductSpec), couponBarrierPct: x };
    case 'callBarrier':
      return { ...(spec as CouponProductSpec), callBarrierPct: x };
    case 'kiBarrier': {
      if (spec.kind === 'participation') {
        const p = spec;
        return { ...p, downside: { ...p.downside, kiBarrierPct: x } };
      }
      return { ...spec, kiBarrierPct: x } as ProductSpec;
    }
    case 'gearing': {
      const p = spec as ParticipationSpec;
      return { ...p, upside: { ...p.upside, participationPct: x } };
    }
    case 'upsideStrike': {
      const p = spec as ParticipationSpec;
      return { ...p, upside: { ...p.upside, strikePct: x } };
    }
    case 'downsideLeverage': {
      const p = spec as ParticipationSpec;
      return { ...p, downside: { ...p.downside, leveragePct: x } };
    }
    case 'bonusLevel': {
      const p = spec as ParticipationSpec;
      return { ...p, bonusPct: x };
    }
    case 'twinWin': {
      const p = spec as ParticipationSpec;
      return { ...p, downside: { ...p.downside, twinWinPct: x } };
    }
    case 'upperStrike': {
      const p = spec as ParticipationSpec;
      if (p.upside.variant.variant !== 'callSpread') throw new Error('upperStrike solve requires callSpread upside');
      return { ...p, upside: { ...p.upside, variant: { ...p.upside.variant, upperStrikePct: x } } };
    }
    case 'upsideKoBarrier': {
      const p = spec as ParticipationSpec;
      if (p.upside.variant.variant !== 'koRebate') throw new Error('upsideKoBarrier solve requires koRebate upside');
      return { ...p, upside: { ...p.upside, variant: { ...p.upside.variant, koBarrierPct: x } } };
    }
    case 'rebate': {
      const p = spec as ParticipationSpec;
      if (p.upside.variant.variant !== 'koRebate') throw new Error('rebate solve requires koRebate upside');
      return { ...p, upside: { ...p.upside, variant: { ...p.upside.variant, rebatePct: x } } };
    }
    case 'strike':
      return { ...spec, strikePct: x } as ProductSpec;
  }
}

/** Bracket + PV target for each solve variable. */
export function solveBounds(
  spec: ProductSpec,
  target: SolveTarget,
): { lo: number; hi: number; hardLo: number; hardHi: number; targetPct: number } {
  const reoffer = spec.kind === 'accumulator' ? spec.upfrontPct : spec.reofferPct;
  switch (target.kind) {
    case 'couponPa':
    case 'acCouponPa':
      return { lo: 0, hi: 25, hardLo: 0, hardHi: 100, targetPct: reoffer };
    case 'couponBarrier':
      return { lo: 1, hi: 150, hardLo: 0.5, hardHi: 300, targetPct: reoffer };
    case 'callBarrier':
      return { lo: 50, hi: 150, hardLo: 10, hardHi: 300, targetPct: reoffer };
    case 'kiBarrier': {
      const cap =
        spec.kind === 'coupon' ? Math.min(spec.putStrikePct, 100) : 100;
      return { lo: 1, hi: cap, hardLo: 0.5, hardHi: cap, targetPct: reoffer };
    }
    case 'gearing':
      return { lo: 0, hi: 1000, hardLo: 0, hardHi: 1000, targetPct: reoffer };
    case 'upsideStrike':
      return { lo: 50, hi: 200, hardLo: 10, hardHi: 300, targetPct: reoffer };
    case 'downsideLeverage':
      return { lo: 0, hi: 300, hardLo: 0, hardHi: 500, targetPct: reoffer };
    case 'bonusLevel':
      return { lo: 0, hi: 100, hardLo: 0, hardHi: 100, targetPct: reoffer };
    case 'twinWin':
      return { lo: 0, hi: 500, hardLo: 0, hardHi: 500, targetPct: reoffer };
    case 'upperStrike': {
      const base =
        spec.kind === 'participation' ? spec.upside.strikePct : 100;
      return { lo: base + 0.5, hi: 250, hardLo: base + 0.1, hardHi: 400, targetPct: reoffer };
    }
    case 'upsideKoBarrier':
      return { lo: 100.5, hi: 250, hardLo: 100.1, hardHi: 400, targetPct: reoffer };
    case 'rebate':
      return { lo: 0, hi: 50, hardLo: 0, hardHi: 100, targetPct: reoffer };
    case 'strike':
      return { lo: 50, hi: 200, hardLo: 10, hardHi: 250, targetPct: reoffer };
    default:
      throw new Error(`solve target ${target.kind} has no bounds`);
  }
}

function notionalOf(spec: ProductSpec, market: MarketData): number {
  if (spec.kind === 'accumulator') {
    const grid = buildGrid(spec);
    return spec.dailyShares * grid.nSteps * (spec.strikePct / 100) * market.spot;
  }
  return spec.notional;
}

export async function executePriceRequest(req: PriceRequest, hooks: PricingHooks): Promise<PriceResult | null> {
  const start = Date.now();
  const { market, mc } = req;
  let spec = req.product;
  let solvedValue: number | undefined;
  let solveIterations: number | undefined;

  const isDirect =
    req.solve.kind === 'none' || req.solve.kind === 'upfront';

  if (!isDirect) {
    const { lo, hi, hardLo, hardHi, targetPct } = solveBounds(spec, req.solve);
    let iter = 0;
    const evalF = async (x: number): Promise<number> => {
      iter += 1;
      hooks.onProgress(0, mc.numPaths, 'solving', iter);
      const r = await priceOnce(
        applySolveValue(spec, req.solve, x),
        market,
        mc.numPaths,
        mc.seed,
        mc.antithetic,
        hooks,
        'solving',
        0,
        mc.numPaths,
        iter,
      );
      if (r.cancelled || hooks.isCancelled()) throw new CancelledError();
      return r.pvPct - targetPct;
    };

    const { root } = await asyncRootFind(evalF, lo, hi, hardLo, hardHi, req.solve.kind);
    solvedValue = root;
    solveIterations = iter;
    spec = applySolveValue(spec, req.solve, root);
  }

  hooks.onProgress(0, mc.numPaths, 'pricing');
  const final = await priceOnce(spec, market, mc.numPaths, mc.seed, mc.antithetic, hooks, 'pricing');
  if (final.cancelled || hooks.isCancelled()) return null;

  if (req.solve.kind === 'upfront') solvedValue = final.pvPct;

  let greeks: PriceResult['greeks'];
  if (req.greeks) {
    hooks.onProgress(0, mc.numPaths * 4, 'greeks');
    const bump = async (m: MarketData, i: number) =>
      priceOnce(spec, m, mc.numPaths, mc.seed, mc.antithetic, hooks, 'greeks', i * mc.numPaths, mc.numPaths * 4);
    const up = await bump({ ...market, spot: market.spot * 1.01 }, 0);
    const dn = await bump({ ...market, spot: market.spot * 0.99 }, 1);
    const vu = await bump({ ...market, vol: market.vol + 0.01 }, 2);
    const vd = await bump({ ...market, vol: Math.max(0.001, market.vol - 0.01) }, 3);
    if ([up, dn, vu, vd].some((r) => r.cancelled) || hooks.isCancelled()) return null;
    greeks = {
      deltaPct: (up.pvPct - dn.pvPct) / 2,
      vegaPct: (vu.pvPct - vd.pvPct) / 2,
    };
  }

  const notional = notionalOf(spec, market);
  return {
    id: req.id,
    pvPct: final.pvPct,
    pvCcy: (final.pvPct / 100) * notional,
    stderrPct: final.stderrPct,
    ci95Pct: [final.pvPct - 1.96 * final.stderrPct, final.pvPct + 1.96 * final.stderrPct],
    solvedValue,
    solveIterations,
    greeks,
    diagnostics: final.diagnostics,
    elapsedMs: Date.now() - start,
  };
}

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

/**
 * Async root finder for MC objectives: bracket expansion toward hard bounds,
 * then Ridders' method (secant-accelerated bisection — robust on smooth CRN
 * objectives, ~8-12 evaluations typical). tolY is in PV percentage points.
 */
async function asyncRootFind(
  f: (x: number) => Promise<number>,
  lo: number,
  hi: number,
  hardLo: number,
  hardHi: number,
  label: string,
  tolX = 1e-4,
  tolY = 0.01,
  maxIter = 40,
): Promise<{ root: number }> {
  let a = lo;
  let b = hi;
  let fa = await f(a);
  if (Math.abs(fa) < tolY) return { root: a };
  let fb = await f(b);
  if (Math.abs(fb) < tolY) return { root: b };

  let guard = 0;
  while (Math.sign(fa) === Math.sign(fb)) {
    if ((a <= hardLo && b >= hardHi) || guard++ >= 12) {
      throw new Error(
        `No solution for ${label} in [${hardLo}, ${hardHi}] — the target level is not reachable with these terms`,
      );
    }
    const width = Math.max(b - a, 1e-3);
    if (a > hardLo) {
      a = Math.max(hardLo, a - width / 2);
      fa = await f(a);
      if (Math.abs(fa) < tolY) return { root: a };
    }
    if (Math.sign(fa) !== Math.sign(fb)) break;
    if (b < hardHi) {
      b = Math.min(hardHi, b + width / 2);
      fb = await f(b);
      if (Math.abs(fb) < tolY) return { root: b };
    }
  }

  for (let i = 0; i < maxIter; i++) {
    const m = 0.5 * (a + b);
    const fm = await f(m);
    if (Math.abs(fm) < tolY || b - a < tolX) return { root: m };
    // Ridders' exponential correction
    const s = Math.sqrt(fm * fm - fa * fb);
    if (s === 0) return { root: m };
    const x = m + (m - a) * ((fa >= fb ? 1 : -1) * fm) / s;
    const fx = await f(x);
    if (Math.abs(fx) < tolY) return { root: x };
    // Re-bracket among {a, m, x, b}
    if (Math.sign(fm) !== Math.sign(fx)) {
      a = Math.min(m, x);
      fa = Math.min(m, x) === m ? fm : fx;
      b = Math.max(m, x);
      fb = Math.max(m, x) === m ? fm : fx;
    } else if (Math.sign(fa) !== Math.sign(fx)) {
      b = x;
      fb = fx;
    } else {
      a = x;
      fa = fx;
    }
    if (b - a < tolX) return { root: 0.5 * (a + b) };
  }
  throw new Error(`Solver for ${label} did not converge within ${maxIter} iterations`);
}
