/**
 * Pricing orchestration: grid and evaluator assembly, sliced Monte Carlo (so
 * the worker can yield to its event loop for cancellation), the LSMC branch
 * for issuer callables, solve-for via bracketed root-finding, and
 * bump-and-reprice Greeks. This module is pure of DOM and worker APIs, so it
 * is testable in node. The worker supplies the hooks.
 */
import type { MarketData } from '../model/market';
import type {
  CouponProductSpec,
  ParticipationSpec,
  ProductSpec,
} from '../model/product';
import type { Diagnostics, PriceRequest, PriceResult, PricingBasis, SolveTarget } from '../model/request';
import { buildGrid } from '../engine/schedule';
import { makeDf } from '../engine/discount';
import { discountRate } from '../model/market';
import { volAtPctOfSpot } from '../model/volSurface';
import { riskStrikeFor } from '../engine/riskStrike';
import { priceIssuerCallable } from '../engine/lsmc';
import { makeEvaluator, makeSplitEvaluator, observablesRequirementsOf } from '../engine/payoffs';
import { makeCouponCashflowExtractor } from '../engine/payoffs/couponProducts';
import type { EvaluatorContext } from '../engine/payoffs/types';
import {
  computeCacheKey,
  computeNormalsKey,
  computeObservablesKey,
  evaluateCachedSlice,
  evaluateCachedSliceSplit,
  gridTimesDigest,
} from '../engine/pathCache';
import type { McRunResult } from '../engine/mc';
import { computeExpectedShortfall, computeHistogram, computePLoss } from '../engine/distribution';
import type { PricingPhase } from './protocol';

/**
 * Farms the slices of ONE priceOnce pass out to a pool of Workers (see
 * src/worker/pool.ts), instead of evaluating them in-process and
 * sequentially. An implementation may run `sliceIndices` concurrently, and
 * in any completion order internally. But it MUST resolve with results in
 * the same order as `sliceIndices` (priceOnce always passes them as
 * [0..nSlices-1]). The pooling reduction in priceOnce sums over the
 * returned array in that order. This order is what keeps pooled pv and
 * stderr bit-identical to the sequential, single-worker path, regardless of
 * which slice happens to finish first.
 */
export interface SliceRunner {
  runSlices(
    spec: ProductSpec,
    market: MarketData,
    numPaths: number,
    seed: number,
    antithetic: boolean,
    sliceIndices: number[],
    /** Invoked once per slice, as soon as that slice's result is available,
     * in any order. `slicePaths` is the number of paths that slice covered.
     * Used to aggregate a monotonically advancing progress bar across
     * workers. */
    onSliceDone: (slicePaths: number) => void,
  ): Promise<McRunResult[]>;
}

export interface PricingHooks {
  /** Called with cumulative progress. */
  onProgress: (pathsDone: number, pathsTotal: number, phase: PricingPhase, solveIteration?: number) => void;
  isCancelled: () => boolean;
  /** Yield to the event loop so cancel messages can arrive. */
  yieldNow: () => Promise<void>;
  /** Optional: farm priceOnce's slices out to a Worker pool, instead of
   * evaluating them in-process. Omitting it, the default, preserves the
   * exact prior sequential, single-process behavior. Every existing caller —
   * tests, bench, the classic single-worker path — leaves this unset. */
  sliceRunner?: SliceRunner;
}

export const SLICE_PATHS = 20_000;

/** Size, path count, of slice `sliceIndex` of a priceOnce pass over
 * `numPaths`. This is the exact `nSlices`/`per`/`slicePaths` formula
 * priceOnce uses internally. Exported as a single source of truth for
 * callers that need a slice's size without re-deriving it, for example
 * src/worker/pricer.worker.ts's pool progress aggregation. */
export function sliceSizeOf(numPaths: number, sliceIndex: number): number {
  const nSlices = Math.max(1, Math.ceil(numPaths / SLICE_PATHS));
  const per = Math.ceil(numPaths / nSlices);
  return Math.min(per, numPaths - sliceIndex * per);
}

/** Reduced path count for a `preview` request, fast and transient pricing
 * during live typing, used when McSettings.previewNumPaths is not
 * specified. */
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
  /**
   * Whether to build the distribution diagnostics: histogram, P(loss), and
   * Expected Shortfall. Only the final displayed pass needs them, and they
   * are not cheap. ES alone copies and comparator-sorts the whole per-path
   * sample array twice. A solve runs priceOnce once per root-finder
   * iteration and throws every intermediate result away. So computing the
   * diagnostics there is pure waste. Defaults to false; callers opt in.
   */
  wantDistribution = false,
): Promise<CoreResult> {
  const grid = buildGrid(spec);
  const ctx: EvaluatorContext = { market, grid, df: makeDf(discountRate(market)) };

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
      // issuerCallable/LSMC always runs on the daily grid (needsDailyPath),
      // so grid.dtYears here is the real uniform step.
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

  // Split evaluator (Phase A observables, Phase B outcome) for the families
  // where it is a true no-op decomposition: coupon non-issuerCallable,
  // participation. See makeSplitEvaluator's doc. Falls back to the
  // monolithic evaluator (accumulator) when null. The monolithic evaluator
  // is also what the split's cache-miss path uses internally (outcome ∘
  // observables). So either path is byte-identical to a fresh runMc call.
  const split = makeSplitEvaluator(spec, ctx);
  const evaluator = split ? undefined : makeEvaluator(spec, ctx);
  const nSlices = Math.max(1, Math.ceil(numPaths / SLICE_PATHS));
  const per = Math.ceil(numPaths / nSlices);

  // Path generation depends only on market, MC settings, and grid. It does
  // not depend on the product spec's strikes, barriers, or coupons. So
  // slices are cached under a key that excludes spec fields entirely. A
  // solve-for — same market, MC settings, and tenor, only the spec changing
  // across iterations — hits this cache on every iteration after the first.
  const cacheKey = computeCacheKey({
    s0: market.spot,
    market,
    numPaths,
    seed,
    antithetic,
    nSteps: grid.nSteps,
    timesKey: gridTimesDigest(grid),
  });
  // Observables (Phase A output) need an additional key component: a
  // signature of the observation index sets (couponObs/callObs) plus the
  // monitoring-mode requirements descriptor, which of minPerf/maxPerf Phase
  // A tracks. The raw path cache stays valid across a schedule or
  // monitoring-mode change mid live-solve, for example couponFrequency
  // changing, or barrierType flipping from european to american. Only the
  // cached observables must recompute.
  const observablesKey = split ? computeObservablesKey(cacheKey, grid, observablesRequirementsOf(spec)) : '';
  // Keyed WITHOUT market data (see computeNormalsKey), so a spot, vol, rate,
  // or div edit, or a greeks bump — which changes `cacheKey` above and
  // evicts the raw-path cache — still hits here. Regeneration then skips
  // Box-Muller entirely (see pathCache.ts's normals cache doc).
  const normalsKey = computeNormalsKey({ numPaths, seed, antithetic, nSteps: grid.nSteps });
  // Reference level for pLoss/ES: what the investor paid, for coupon or
  // participation, or 0 for accumulator. The accumulator's PV is already a
  // P&L-style value in % of estimated notional, not a price paid — see
  // Diagnostics.pLoss doc.
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

  // `slices[s]` results, gathered either sequentially in-process — the
  // default, every existing caller: tests, bench, the no-pool worker — or,
  // when `hooks.sliceRunner` is supplied (browser real client, farming
  // slices across a Worker pool — see src/worker/pool.ts), concurrently
  // across workers. EITHER WAY, the reduction below walks `slices` in index
  // order 0..nSlices-1, and performs the exact same weighted-sum arithmetic
  // in the same order. So pv, stderr, and diagnostics are bit-identical,
  // regardless of how, how fast, or in what completion order the slices
  // were computed. See tests/pool.test.ts.
  const slices: (McRunResult | undefined)[] = new Array(nSlices);

  if (hooks.sliceRunner) {
    if (hooks.isCancelled()) {
      cancelled = true;
    } else {
      const indices = Array.from({ length: nSlices }, (_, s) => s);
      let pathsDone = 0;
      const results = await hooks.sliceRunner.runSlices(
        spec,
        market,
        numPaths,
        seed,
        antithetic,
        indices,
        (slicePaths) => {
          pathsDone += slicePaths;
          hooks.onProgress(progressBase + pathsDone, progressTotal ?? numPaths, phase, solveIteration);
        },
      );
      for (let s = 0; s < nSlices; s++) slices[s] = results[s];
      await hooks.yieldNow();
    }
  } else {
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
            grid.stepDt,
            market.spot,
            market,
            observablesKey,
            split.observables,
            split.outcome,
            undefined,
            normalsKey,
          )
        : evaluateCachedSlice(
            cacheKey,
            s,
            seed + s * 7919,
            slicePaths,
            antithetic,
            grid.nSteps,
            grid.stepDt,
            market.spot,
            market,
            evaluator!,
            undefined,
            normalsKey,
          );
      slices[s] = res;
      if (res.cancelled) {
        cancelled = true;
        break;
      }
      hooks.onProgress(progressBase + (s + 1) * per, progressTotal ?? numPaths, phase, solveIteration);
      await hooks.yieldNow();
    }
  }

  for (let s = 0; s < nSlices; s++) {
    const res = slices[s];
    if (!res) break; // not reached (cancelled before/at this slice)
    const slicePaths = Math.min(per, numPaths - s * per);
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
    if (wantDistribution) {
      for (const sample of res.samples) allSamples.push(sample);
    }
    if (res.cancelled) cancelled = true;
  }

  const W = wSum > 0 ? wSum : 1;
  // Computed once over the full concatenated sample set, not per slice. ES
  // and histogram do not combine linearly across slices the way weighted
  // means do. So per-slice values would be wrong for the global picture.
  let histogram: { binEdges: number[]; counts: number[] } | undefined;
  let pLoss: number | undefined;
  let expectedShortfall5: number | undefined;
  let expectedShortfall1: number | undefined;
  if (wantDistribution && allSamples.length > 0) {
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

/**
 * Evaluates exactly ONE slice of a priceOnce pass, self-contained and
 * synchronous. Everything it needs — spec, market, numPaths, seed,
 * antithetic, sliceIndex — is plain, structured-cloneable data. So this is
 * the function a pool worker's RPC handler calls (see src/worker/pool.ts and
 * src/worker/pricer.worker.ts). The coordinator, the main thread, never
 * ships closures across the postMessage boundary, only this call's
 * arguments. Each pool worker rebuilds its own grid, evaluator, and cache
 * keys exactly as priceOnce's in-process loop does.
 *
 * NOT used by the LSMC/issuerCallable branch. That branch always runs as one
 * synchronous priceOnce pass on a single worker (see executePriceRequest and
 * pool.ts's `runIssuerCallable`).
 */
export function evaluatePriceSlice(
  spec: ProductSpec,
  market: MarketData,
  numPaths: number,
  seed: number,
  antithetic: boolean,
  sliceIndex: number,
): McRunResult {
  const grid = buildGrid(spec);
  const ctx: EvaluatorContext = { market, grid, df: makeDf(discountRate(market)) };
  const split = makeSplitEvaluator(spec, ctx);
  const evaluator = split ? undefined : makeEvaluator(spec, ctx);
  const nSlices = Math.max(1, Math.ceil(numPaths / SLICE_PATHS));
  const per = Math.ceil(numPaths / nSlices);
  const slicePaths = Math.min(per, numPaths - sliceIndex * per);

  const cacheKey = computeCacheKey({
    s0: market.spot,
    market,
    numPaths,
    seed,
    antithetic,
    nSteps: grid.nSteps,
    timesKey: gridTimesDigest(grid),
  });
  const observablesKey = split ? computeObservablesKey(cacheKey, grid, observablesRequirementsOf(spec)) : '';
  const normalsKey = computeNormalsKey({ numPaths, seed, antithetic, nSteps: grid.nSteps });

  return split
    ? evaluateCachedSliceSplit(
        cacheKey,
        sliceIndex,
        seed + sliceIndex * 7919,
        slicePaths,
        antithetic,
        grid.nSteps,
        grid.stepDt,
        market.spot,
        market,
        observablesKey,
        split.observables,
        split.outcome,
        undefined,
        normalsKey,
      )
    : evaluateCachedSlice(
        cacheKey,
        sliceIndex,
        seed + sliceIndex * 7919,
        slicePaths,
        antithetic,
        grid.nSteps,
        grid.stepDt,
        market.spot,
        market,
        evaluator!,
        undefined,
        normalsKey,
      );
}

/** Immutably applies a solve variable to the spec. */
export function applySolveValue(spec: ProductSpec, target: SolveTarget, x: number): ProductSpec {
  switch (target.kind) {
    case 'none':
      // Solving for the price makes the REOFFER (accumulator: upfront) the
      // output, and runPricing writes the computed PV back into it. So fold it
      // out here the same way every other target folds out its own field.
      // useLiveReprice builds its watched signature through this function; if
      // the field stayed in, writing the solved value back would change the
      // signature, retrigger another live pass, and jitter forever — the exact
      // failure previously seen on the AQ/DQ upfront solve.
      if (spec.kind === 'accumulator') return { ...spec, upfrontPct: x };
      return { ...spec, reofferPct: x };
    case 'upfront':
      // 'upfront' is not an input the solver roots on. executePriceRequest's
      // isDirect check means this branch is only ever reached with x=0, from
      // useLiveReprice's watched-signature exclusion (see that file). Fold
      // upfrontPct out of the watched signature, the same way every other
      // solve target folds out its own field. Otherwise, writing the solved
      // upfront value back into the spec keeps changing the signature. That
      // retriggers another live reprice forever: the price jitters and never
      // settles.
      return spec.kind === 'accumulator' ? { ...spec, upfrontPct: x } : spec;
    case 'couponPa':
      return { ...(spec as CouponProductSpec), couponPaPct: x };
    case 'acCouponPa':
      return { ...(spec as CouponProductSpec), acCouponPct: x };
    case 'couponBarrier':
      return { ...(spec as CouponProductSpec), couponBarrierPct: x };
    case 'callBarrier':
      return { ...(spec as CouponProductSpec), callBarrierPct: x };
    case 'putStrike':
      return { ...(spec as CouponProductSpec), putStrikePct: x };
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
    case 'koTrigger':
      return { ...spec, koTriggerPct: x } as ProductSpec;
  }
}

/**
 * Bracket and PV target for each solve variable.
 *
 * `feePct` is the fee the issuer retains out of the reoffer. So the
 * STRUCTURE only has to be worth `reoffer − fee`. Lowering the target is
 * what makes a fee-bearing quote less aggressive than a fair value. This is
 * the dominant reason a bank's coupon sits below the risk-neutral one.
 */
export function solveBounds(
  spec: ProductSpec,
  target: SolveTarget,
  feePct = 0,
): { lo: number; hi: number; hardLo: number; hardHi: number; targetPct: number } {
  const reoffer = (spec.kind === 'accumulator' ? spec.upfrontPct : spec.reofferPct) - feePct;
  switch (target.kind) {
    case 'couponPa':
    case 'acCouponPa':
      return { lo: 0, hi: 25, hardLo: 0, hardHi: 100, targetPct: reoffer };
    case 'couponBarrier':
      return { lo: 1, hi: 150, hardLo: 0.5, hardHi: 300, targetPct: reoffer };
    case 'callBarrier':
      return { lo: 50, hi: 150, hardLo: 10, hardHi: 300, targetPct: reoffer };
    // A higher put strike means the short put attaches sooner and loses more,
    // so PV falls as the strike rises — monotone, just decreasing.
    case 'putStrike':
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
    // Accumulator knock-out trigger. A more distant trigger keeps the trade
    // alive longer, so it moves the upfront monotonically.
    case 'koTrigger':
      return { lo: 100.5, hi: 200, hardLo: 100.1, hardHi: 400, targetPct: reoffer };
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

/**
 * Resolves the market the Monte Carlo should actually run on, plus the basis
 * describing that choice. With no surface, the function returns the market
 * unchanged and reports flat-vol pricing. So behavior is identical to
 * before.
 */
function effectiveMarketFor(
  spec: ProductSpec,
  market: MarketData,
): { market: MarketData; basis: PricingBasis } {
  const feePct = market.costs?.feePct ?? 0;
  const dr = discountRate(market);
  // A dead-flat surface (no strike skew — see VolSurface.isFlat) returns the
  // same vol at every strike, so reading market.vol directly is numerically
  // IDENTICAL to reading the surface at the risk strike (see
  // tests/costsAndSkew.test.ts's flat-surface-vs-no-surface parity check).
  // Treat it exactly like "no surface": same code path, and the reporting
  // says so honestly instead of claiming a skew that is not there.
  if (!market.volSurface || market.volSurface.isFlat) {
    return {
      market,
      basis: { volUsed: market.vol, volSource: 'flat', discountRate: dr, feePct },
    };
  }
  const { strikePct, reason } = riskStrikeFor(spec);
  const volUsed = volAtPctOfSpot(market.volSurface, strikePct, spec.tenorYears);
  return {
    market: { ...market, vol: volUsed },
    basis: {
      volUsed,
      volSource: 'surface',
      riskStrikePct: strikePct,
      riskStrikeReason: reason,
      discountRate: dr,
      feePct,
    },
  };
}

export async function executePriceRequest(req: PriceRequest, hooks: PricingHooks): Promise<PriceResult | null> {
  const start = Date.now();
  const { mc } = req;
  // The Contract Lab is a pricing sandbox for now, not a solver surface —
  // see model/lab.ts and engine/combinators/lab.ts. Solve targets are
  // defined per hand-written product family (couponPa, kiBarrier, strike,
  // ...) and applySolveValue/solveBounds have no Lab cases. LabModal never
  // offers solve controls, so this should never fire from the UI; it exists
  // so a Lab request built any other way fails clearly, not by mispricing.
  if (req.product.kind === 'lab' && req.solve.kind !== 'none') {
    throw new Error('Lab contracts price directly; solving for a Lab term is not supported yet.');
  }
  // Skew: when a surface is available, price the product at the vol of ITS OWN
  // risk strike, rather than at the flat/ATM vol. These payoffs live away from
  // the money. So that choice moves the price materially. See
  // engine/riskStrike for which strike governs each family.
  //
  // The effective vol is fixed ONCE here, from the spec as submitted, and held
  // for every pass of a solve. Recomputing it per iteration — which matters
  // only when solving the barrier itself — would change `vol` on each trial.
  // That would change the path-cache key, evicting the cache and undoing the
  // interactive solve speed. The vol is a modelling choice, not a payoff term.
  // So holding it constant across the solve is the right trade. It does mean a
  // solved barrier is priced at the vol of the STARTING barrier.
  const basis = effectiveMarketFor(req.product, req.market);
  const market = basis.market;
  const feePct = market.costs?.feePct ?? 0;
  // A `preview` request runs at a reduced path count for fast, transient
  // pricing during live typing. The trailing-edge "settle" request uses the
  // full mc.numPaths, and is the authoritative result. Both the solve loop
  // and the final pricing pass below use this one path count consistently.
  // A solve's final priceOnce must match the paths it was solved against.
  const numPaths = req.preview ? mc.previewNumPaths ?? DEFAULT_PREVIEW_PATHS : mc.numPaths;
  let spec = req.product;
  let solvedValue: number | undefined;
  let solveIterations: number | undefined;
  let solveWarmStart: boolean | undefined;

  const isDirect =
    req.solve.kind === 'none' || req.solve.kind === 'upfront';

  if (!isDirect) {
    const { lo, hi, hardLo, hardHi, targetPct } = solveBounds(spec, req.solve, feePct);
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
  // Only this pass's result is displayed. So it is the only one that pays for
  // the distribution diagnostics. Solve iterations and greeks bumps skip them.
  const final = await priceOnce(
    spec,
    market,
    numPaths,
    mc.seed,
    mc.antithetic,
    hooks,
    'pricing',
    0,
    undefined,
    undefined,
    true,
  );
  if (final.cancelled || hooks.isCancelled()) return null;

  if (req.solve.kind === 'upfront') solvedValue = final.pvPct;

  let greeks: PriceResult['greeks'];
  if (req.greeks) {
    // Delta is reported as exactly 0 WITHOUT running any MC, instead of via
    // bump-and-reprice. Every payoff family here — coupon, participation,
    // accumulator — is priced as a PERCENTAGE of notional, and reads only
    // relative performance, spots[i]/spots[0] (see the payoffs modules).
    // `fillPath` (gbm.ts) sets `spots[0] = s0`, and every subsequent spot
    // equals s0 times a multiplicative factor. So scaling s0 by (1+e) scales
    // EVERY spot on the path by the same (1+e), and leaves every
    // spots[i]/spots[0] ratio unchanged. This means the whole path of
    // relative performance, and so PV%, stays exactly unchanged. This is not
    // an empirical near-zero. It is a structural identity of "price at
    // inception, spot equals initial fixing". So a spot bump-and-reprice
    // pair was always going to return approximately 0 — the ~1e-14 the old
    // code observed was float noise around an exact analytic zero. This
    // stops being true once the model separates the initial fixing from the
    // live spot, for example a seasoned or live trade repriced mid-life,
    // where performance is measured off a fixing struck in the past at a
    // different level than today's spot. Whoever adds that case needs to
    // bring back a real spot bump here.
    hooks.onProgress(0, numPaths * 2, 'greeks');
    const bump = async (m: MarketData, i: number) =>
      priceOnce(spec, m, numPaths, mc.seed, mc.antithetic, hooks, 'greeks', i * numPaths, numPaths * 2);
    // Bumping vol here also shifts the quanto drift term (−corrEqFx · vol · fxVol
    // in riskNeutralDrift). So under a quanto, this vega is the *total* vega:
    // vol's effect on both the diffusion and the drift. This is intentional.
    // It is the correct sensitivity to a re-quoted equity vol, not a bug.
    const vu = await bump({ ...market, vol: market.vol + 0.01 }, 0);
    const vd = await bump({ ...market, vol: Math.max(0.001, market.vol - 0.01) }, 1);
    if ([vu, vd].some((r) => r.cancelled) || hooks.isCancelled()) return null;
    greeks = {
      deltaPct: 0,
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
    // What the number was actually built on: which point of the vol surface,
    // the discount rate including any funding spread, and the fee retained.
    basis: { ...basis.basis, fairValuePct: final.pvPct },
  };
}

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

/**
 * Ridders' method: secant-accelerated bisection, robust on smooth CRN
 * objectives, typically 8-12 evaluations. Takes an already-valid bracket
 * [a, b] with opposite-signed f(a) and f(b). Shared by both the cold-start
 * bracket-expansion path and the warm-start tight-bracket path in
 * asyncRootFind below. The answer this converges to depends only on f and
 * the bracket, not on how the function found the bracket.
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
 * Async root finder for MC objectives. It has two entry paths into the same
 * Ridders' loop:
 *
 * - Warm start (a guess is given): try a TIGHT bracket around the
 *   previously solved value first, a few evaluations, typically 2-3 total.
 *   If that tight bracket does not actually contain the root — the signs
 *   match, meaning the guess was stale, for example the product changed
 *   enough that the root moved past it — fall through to the cold-start
 *   path below, rather than fail. The guess only ever changes *how fast*
 *   the function finds the answer, never the answer itself.
 * - Cold start: bracket expansion from [lo, hi] toward [hardLo, hardHi],
 *   until the signs of f at the two ends differ, then the Ridders' loop.
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
