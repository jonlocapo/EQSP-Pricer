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
import { priceIssuerCallable } from '../engine/lsmc';
import { makeEvaluator, makeSplitEvaluator } from '../engine/payoffs';
import { makeCouponCashflowExtractor } from '../engine/payoffs/couponProducts';
import type { EvaluatorContext } from '../engine/payoffs/types';
import { computeCacheKey, computeObservablesKey, evaluateCachedSlice, evaluateCachedSliceSplit } from '../engine/pathCache';
import { computeExpectedShortfall, computeHistogram, computePLoss } from '../engine/distribution';
import { chebyshevLobattoSpotNodes } from '../engine/chebyshev';
import type { PricingPhase, ProfileRequest, ProfileResult } from './protocol';

export interface PricingHooks {
  /** Called with cumulative progress. */
  onProgress: (pathsDone: number, pathsTotal: number, phase: PricingPhase, solveIteration?: number) => void;
  isCancelled: () => boolean;
  /** Yield to the event loop so cancel messages can arrive. */
  yieldNow: () => Promise<void>;
}

/** Hooks for a profile run — progress is reported per Chebyshev node, not
 * per path (a single node's `priceOnce` doesn't report its own path
 * progress; node-level granularity is what the UI needs for a progress bar
 * across N+1 independent full pricings). */
export interface ProfileHooks {
  onProgress: (nodesDone: number, nodesTotal: number) => void;
  isCancelled: () => boolean;
  yieldNow: () => Promise<void>;
}

const SLICE_PATHS = 20_000;

/** Reduced path count for a `preview` request (fast, transient pricing
 * during live typing) when McSettings.previewNumPaths isn't specified. */
export const DEFAULT_PREVIEW_PATHS = 20_000;

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

  // Split evaluator (Phase A observables / Phase B outcome) for the families
  // where it's a true no-op decomposition (coupon non-issuerCallable,
  // participation — see makeSplitEvaluator's doc). Falls back to the
  // monolithic evaluator (accumulator) when null; the monolithic evaluator
  // is also what the split's cache-miss path uses internally (outcome ∘
  // observables), so either path is byte-identical to a fresh runMc call.
  const split = makeSplitEvaluator(spec, ctx);
  const evaluator = split ? undefined : makeEvaluator(spec, ctx);
  const nSlices = Math.max(1, Math.ceil(numPaths / SLICE_PATHS));
  const per = Math.ceil(numPaths / nSlices);

  // Path generation depends only on market/mc/grid — not on the product
  // spec's strikes/barriers/coupons — so slices are cached under a key that
  // excludes spec fields entirely. A solve-for (same market+mc+tenor, only
  // the spec changing across iterations) hits this cache on every iteration
  // after the first.
  const cacheKey = computeCacheKey({
    s0: market.spot,
    market,
    numPaths,
    seed,
    antithetic,
    nSteps: grid.nSteps,
    dtYears: grid.dtYears,
  });
  // Observables (Phase A output) need an additional key component: a
  // signature of the observation index sets (couponObs/callObs). The raw
  // path cache stays valid across a schedule change (e.g. couponFrequency
  // mid live-solve); only the cached observables must recompute.
  const observablesKey = split ? computeObservablesKey(cacheKey, grid) : '';
  // Reference level for pLoss/ES: what the investor paid (coupon/
  // participation), or 0 for accumulator (its PV is already a P&L-style
  // value in % of estimated notional, not a price paid — see Diagnostics.pLoss doc).
  const referenceLevelPct = spec.kind === 'accumulator' ? 0 : spec.issuePricePct;

  let wSum = 0;
  let pvSum = 0;
  let varSum = 0; // Σ w² · stderr²
  let kiSum = 0;
  let upKoSum = 0;
  let koSum = 0;
  let lifeSum = 0;
  const callCounts: number[] = [];
  const allSamples: number[] = [];
  let cancelled = false;

  for (let s = 0; s < nSlices; s++) {
    if (hooks.isCancelled()) {
      cancelled = true;
      break;
    }
    const slicePaths = Math.min(per, numPaths - s * per);
    const res = split
      ? evaluateCachedSliceSplit(
          cacheKey,
          s,
          seed + s * 7919,
          slicePaths,
          antithetic,
          grid.nSteps,
          grid.dtYears,
          market.spot,
          market,
          observablesKey,
          split.observables,
          split.outcome,
        )
      : evaluateCachedSlice(
          cacheKey,
          s,
          seed + s * 7919,
          slicePaths,
          antithetic,
          grid.nSteps,
          grid.dtYears,
          market.spot,
          market,
          evaluator!,
        );
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
    for (const sample of res.samples) allSamples.push(sample);
    if (res.cancelled) {
      cancelled = true;
      break;
    }
    hooks.onProgress(progressBase + (s + 1) * per, progressTotal ?? numPaths, phase, solveIteration);
    await hooks.yieldNow();
  }

  const W = wSum > 0 ? wSum : 1;
  // Computed once over the full concatenated sample set (not per-slice —
  // ES/histogram don't combine linearly across slices the way weighted
  // means do, so per-slice values would be wrong for the global picture).
  let histogram: { binEdges: number[]; counts: number[] } | undefined;
  let pLoss: number | undefined;
  let expectedShortfall5: number | undefined;
  let expectedShortfall1: number | undefined;
  if (allSamples.length > 0) {
    histogram = computeHistogram(allSamples);
    pLoss = computePLoss(allSamples, referenceLevelPct);
    expectedShortfall5 = computeExpectedShortfall(allSamples, 0.05);
    expectedShortfall1 = computeExpectedShortfall(allSamples, 0.01);
  }

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
      histogram,
      pLoss,
      expectedShortfall5,
      expectedShortfall1,
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
  // A `preview` request runs at a reduced path count for fast, transient
  // pricing during live typing; the trailing-edge "settle" request uses the
  // full mc.numPaths and is the authoritative result. Both the solve loop
  // and the final pricing pass below use this one path count consistently
  // (a solve's final priceOnce must match the paths it was solved against).
  const numPaths = req.preview ? mc.previewNumPaths ?? DEFAULT_PREVIEW_PATHS : mc.numPaths;
  let spec = req.product;
  let solvedValue: number | undefined;
  let solveIterations: number | undefined;
  let solveWarmStart: boolean | undefined;

  const isDirect =
    req.solve.kind === 'none' || req.solve.kind === 'upfront';

  if (!isDirect) {
    const { lo, hi, hardLo, hardHi, targetPct } = solveBounds(spec, req.solve);
    let iter = 0;
    const evalF = async (x: number): Promise<number> => {
      iter += 1;
      hooks.onProgress(0, numPaths, 'solving', iter);
      const r = await priceOnce(
        applySolveValue(spec, req.solve, x),
        market,
        numPaths,
        mc.seed,
        mc.antithetic,
        hooks,
        'solving',
        0,
        numPaths,
        iter,
      );
      if (r.cancelled || hooks.isCancelled()) throw new CancelledError();
      return r.pvPct - targetPct;
    };

    const { root, warmStart } = await asyncRootFind(
      evalF,
      lo,
      hi,
      hardLo,
      hardHi,
      req.solve.kind,
      req.warmStartValue,
    );
    solvedValue = root;
    solveIterations = iter;
    solveWarmStart = warmStart;
    spec = applySolveValue(spec, req.solve, root);
  }

  hooks.onProgress(0, numPaths, 'pricing');
  const final = await priceOnce(spec, market, numPaths, mc.seed, mc.antithetic, hooks, 'pricing');
  if (final.cancelled || hooks.isCancelled()) return null;

  if (req.solve.kind === 'upfront') solvedValue = final.pvPct;

  let greeks: PriceResult['greeks'];
  if (req.greeks) {
    hooks.onProgress(0, numPaths * 4, 'greeks');
    const bump = async (m: MarketData, i: number) =>
      priceOnce(spec, m, numPaths, mc.seed, mc.antithetic, hooks, 'greeks', i * numPaths, numPaths * 4);
    const up = await bump({ ...market, spot: market.spot * 1.01 }, 0);
    const dn = await bump({ ...market, spot: market.spot * 0.99 }, 1);
    // Bumping vol here also shifts the quanto drift term (−corrEqFx · vol · fxVol
    // in riskNeutralDrift), so under a quanto this vega is the *total* vega —
    // vol's effect on both the diffusion and the drift. That's intentional:
    // it's the correct sensitivity to a re-quoted equity vol, not a bug.
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
    solveWarmStart,
    greeks,
    diagnostics: final.diagnostics,
    elapsedMs: Date.now() - start,
    preview: req.preview,
  };
}

const DEFAULT_PROFILE_N = 32;
const DEFAULT_PROFILE_RANGE_FRAC = 0.5;

/**
 * Prices `req.product` at N+1 Chebyshev-Lobatto spot nodes spanning
 * [spot*(1-rangeFrac), spot*(1+rangeFrac)] — the up-front cost of the
 * Chebyshev surrogate. Reuses `priceOnce` as a black box (no solve, no
 * bump-and-reprice greeks) once per node.
 *
 * CORRECTNESS: every node uses the exact same mc.seed/numPaths/antithetic.
 * The path cache doesn't help here (it keys on spot, and every node has a
 * different spot), but common random numbers across nodes is what makes
 * PV(spot) smooth — without it, independent MC noise per node would make
 * the curve jagged and its analytic derivatives (delta/gamma) meaningless.
 */
export async function executeProfileRequest(req: ProfileRequest, hooks: ProfileHooks): Promise<ProfileResult | null> {
  const { market, mc } = req;
  const N = req.N ?? DEFAULT_PROFILE_N;
  const rangeFrac = req.rangeFrac ?? DEFAULT_PROFILE_RANGE_FRAC;
  const spotLo = market.spot * (1 - rangeFrac);
  const spotHi = market.spot * (1 + rangeFrac);
  const spotNodes = chebyshevLobattoSpotNodes(N, spotLo, spotHi);

  // priceOnce reports path-level progress; the profile UI only needs
  // node-level granularity, so its onProgress is a no-op here.
  const innerHooks: PricingHooks = {
    onProgress: () => {},
    isCancelled: hooks.isCancelled,
    yieldNow: hooks.yieldNow,
  };

  const nodes: ProfileResult['nodes'] = [];
  for (let k = 0; k <= N; k++) {
    if (hooks.isCancelled()) return null;
    const spot = spotNodes[k];
    const nodeMarket: MarketData = { ...market, spot };
    const res = await priceOnce(req.product, nodeMarket, mc.numPaths, mc.seed, mc.antithetic, innerHooks, 'pricing');
    if (res.cancelled || hooks.isCancelled()) return null;
    nodes.push({ spot, pvPct: res.pvPct, stderrPct: res.stderrPct });
    hooks.onProgress(k + 1, N + 1);
    await hooks.yieldNow();
  }

  return { id: req.id, nodes, spotLo, spotHi, N };
}

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

/**
 * Ridders' method (secant-accelerated bisection — robust on smooth CRN
 * objectives, ~8-12 evaluations typical) given an already-valid bracket
 * [a, b] with opposite-signed f(a)/f(b). Shared by both the cold-start
 * bracket-expansion path and the warm-start tight-bracket path in
 * asyncRootFind below — the answer this converges to depends only on f and
 * the bracket, not on how the bracket was found.
 */
async function riddersLoop(
  f: (x: number) => Promise<number>,
  a: number,
  b: number,
  fa: number,
  fb: number,
  tolX: number,
  tolY: number,
  maxIter: number,
  label: string,
): Promise<number> {
  for (let i = 0; i < maxIter; i++) {
    const m = 0.5 * (a + b);
    const fm = await f(m);
    if (Math.abs(fm) < tolY || b - a < tolX) return m;
    // Ridders' exponential correction
    const s = Math.sqrt(fm * fm - fa * fb);
    if (s === 0) return m;
    const x = m + (m - a) * ((fa >= fb ? 1 : -1) * fm) / s;
    const fx = await f(x);
    if (Math.abs(fx) < tolY) return x;
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
    if (b - a < tolX) return 0.5 * (a + b);
  }
  throw new Error(`Solver for ${label} did not converge within ${maxIter} iterations`);
}

/**
 * Async root finder for MC objectives. Two entry paths into the same
 * Ridders' loop:
 *
 * - Warm start (guess given): try a TIGHT bracket around the previously
 *   solved value first (a few evaluations, typically 2-3 total). If that
 *   tight bracket doesn't actually contain the root (signs match — the
 *   guess was stale, e.g. the product changed enough that the root moved
 *   past it), fall through to the cold-start path below rather than fail —
 *   the guess only ever changes *how fast* the answer is found, never the
 *   answer itself.
 * - Cold start: bracket expansion from [lo, hi] toward [hardLo, hardHi]
 *   until the signs of f at the two ends differ, then Ridders' loop.
 *
 * tolY is in PV percentage points.
 */
async function asyncRootFind(
  f: (x: number) => Promise<number>,
  lo: number,
  hi: number,
  hardLo: number,
  hardHi: number,
  label: string,
  guess?: number,
  tolX = 1e-4,
  tolY = 0.01,
  maxIter = 40,
): Promise<{ root: number; warmStart: boolean }> {
  if (guess !== undefined && Number.isFinite(guess)) {
    const fullWidth = Math.max(hi - lo, 1e-3);
    const tightFrac = 0.08;
    const a0 = Math.max(hardLo, guess - tightFrac * fullWidth);
    const b0 = Math.min(hardHi, guess + tightFrac * fullWidth);
    if (b0 > a0) {
      const fa0 = await f(a0);
      if (Math.abs(fa0) < tolY) return { root: a0, warmStart: true };
      const fb0 = await f(b0);
      if (Math.abs(fb0) < tolY) return { root: b0, warmStart: true };
      if (Math.sign(fa0) !== Math.sign(fb0)) {
        const root = await riddersLoop(f, a0, b0, fa0, fb0, tolX, tolY, maxIter, label);
        return { root, warmStart: true };
      }
      // Tight bracket didn't contain the root — fall through to cold start.
    }
  }

  let a = lo;
  let b = hi;
  let fa = await f(a);
  if (Math.abs(fa) < tolY) return { root: a, warmStart: false };
  let fb = await f(b);
  if (Math.abs(fb) < tolY) return { root: b, warmStart: false };

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
      if (Math.abs(fa) < tolY) return { root: a, warmStart: false };
    }
    if (Math.sign(fa) !== Math.sign(fb)) break;
    if (b < hardHi) {
      b = Math.min(hardHi, b + width / 2);
      fb = await f(b);
      if (Math.abs(fb) < tolY) return { root: b, warmStart: false };
    }
  }

  const root = await riddersLoop(f, a, b, fa, fb, tolX, tolY, maxIter, label);
  return { root, warmStart: false };
}
