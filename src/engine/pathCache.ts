/**
 * Single-entry cache of raw simulated GBM paths, scoped to the worker
 * module. This is a module-level singleton. It persists across
 * `executePriceRequest` calls within the same worker instance, not per
 * request.
 *
 * Path *generation* (GBM stepping) is the expensive part of MC pricing.
 * Payoff *evaluation* is comparatively cheap. Generated paths depend only on
 * market data, MC settings (numPaths/seed/antithetic), and the path grid
 * shape (nSteps/dtYears). They do not depend on product terms
 * (strikes/barriers/coupons). So during a solve-for — many `priceOnce` calls
 * with the same market, MC settings, and tenor, where only the product spec
 * changes — the solver can reuse the same raw paths across every iteration,
 * and re-run only the cheap evaluator.
 *
 * The cache is capped at a single key: any mismatch evicts and replaces the
 * entry, to bound memory. 100k paths × ~253 steps × 8 bytes is already about
 * 200MB to hold once; multiple entries would multiply that.
 *
 * This module leaves `runMc` (streaming, no retention) untouched — `runMc`
 * stays the small, serial, test-facing API. This cache is a worker-side
 * optimization layered on top via `evaluatePathSource`. So a cache hit is
 * byte-identical to a fresh `runMc` run of the same spec.
 */
import type { MarketData } from '../model/market';
import { PathBatchGenerator } from './gbm';
import type { ZSlice } from './gbm';
import { normals } from './rng';
import { Aggregator, evaluatePathSource } from './mc';
import type { McRunResult, PathSource } from './mc';
import type {
  ObservablesEvaluator,
  ObservablesRequirements,
  OutcomeEvaluator,
  PathObservables,
  PayoffEvaluator,
  PricingGrid,
} from './payoffs/types';

interface StoredSlice {
  antithetic: boolean;
  pairs?: { plus: Float64Array; minus: Float64Array }[];
  singles?: Float64Array[];
}

/** Same shape as StoredSlice, but holds cached per-path observables instead
 * of raw spots. Phase A produces these observables, a handful of floats
 * each. */
interface StoredObservablesSlice {
  antithetic: boolean;
  pairs?: { plus: PathObservables; minus: PathObservables }[];
  singles?: PathObservables[];
}

interface CacheEntry {
  key: string;
  slices: (StoredSlice | undefined)[];
  /** Signature of the observation index sets (couponObs/callObs) the cached
   * observables were computed against. A schedule change (e.g. coupon
   * frequency) invalidates only this, not the raw path slices. */
  obsKey?: string;
  obsSlices?: (StoredObservablesSlice | undefined)[];
}

let entry: CacheEntry | null = null;

/** Deterministic stringify (sorted object keys) so field order never
 * affects the cache key. */
function stableStringify(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export interface CacheKeyParams {
  s0: number;
  market: MarketData;
  numPaths: number;
  seed: number;
  antithetic: boolean;
  nSteps: number;
  /** Cheap, stable digest of the grid's per-step-time vector (see
   * `gridTimesDigest`), NOT just nSteps/dtYears. An adaptive, possibly
   * non-uniform, grid can have two different `times` vectors for the same
   * nSteps. For example, a quarterly-coupon-only schedule and a merged
   * quarterly-coupon plus monthly-call schedule can happen to produce the
   * same step count. So nSteps alone is no longer a safe cache key
   * component. Using nSteps alone would let two genuinely different grids
   * collide and replay the wrong paths. */
  timesKey: string;
}

/** Cheap, stable digest of a grid's step-time vector, for use in a cache
 * key. `times` arrays are small, at most a few hundred entries even for the
 * daily grid. So a full join is cheap and unambiguous. This function runs
 * once per `priceOnce` call, never per path. */
export function gridTimesDigest(grid: PricingGrid): string {
  return `${grid.nSteps}:${grid.times.join(',')}`;
}

/** Cache key: market data + MC settings + grid shape — everything path
 * generation depends on, and nothing product-specific. `volPerStep` is
 * included: a per-step vol schedule changes every path, even when
 * `market.vol` (the flat anchor) is unchanged. The borrow cost is included
 * too: it enters `riskNeutralDrift` as an extra dividend, so it moves every
 * path — a change that used to leave the cache warm and silently reuse stale
 * paths. (Funding spread and fee only move discounting and valuation, which
 * the path cache does not own, so they are deliberately absent.) */
export function computeCacheKey(p: CacheKeyParams): string {
  return stableStringify({
    spot: p.s0,
    vol: p.market.vol,
    volPerStep: p.market.volPerStep,
    rate: p.market.rate,
    rateCurve: p.market.rateCurve,
    divYield: p.market.divYield,
    // Every basket leg's vol and dividend, and the whole correlation matrix.
    // Two DIFFERENT baskets can share the same scalar spot, vol and divYield
    // above, so without this the cache would hand one basket's paths to the
    // other and price it confidently wrong with nothing logged.
    basket: p.market.basket
      ? {
          assets: p.market.basket.assets.map((a) => ({ vol: a.vol, divYield: a.divYield })),
          correlation: p.market.basket.correlation,
        }
      : undefined,
    borrowCost: p.market.costs?.borrowCostBp ?? 0,
    quanto: p.market.quanto
      ? {
          rateUnderlying: p.market.quanto.rateUnderlying,
          fxVol: p.market.quanto.fxVol,
          corrEqFx: p.market.quanto.corrEqFx,
        }
      : undefined,
    numPaths: p.numPaths,
    seed: p.seed,
    antithetic: p.antithetic,
    nSteps: p.nSteps,
    times: p.timesKey,
  });
}

/**
 * Observables depend on the raw paths, already covered by
 * `computeCacheKey`, plus the observation index sets (grid.couponObs /
 * grid.callObs) and the requirements descriptor. The requirements
 * descriptor says which of minPerf/maxPerf Phase A actually tracks (see
 * `ObservablesRequirements`). Observables do NOT depend on any numeric spec
 * parameter, such as barrier or coupon LEVELS. During a typical solve, the
 * schedule and monitoring MODE stay fixed and only levels change. So this
 * key stays constant, and observables hit on every iteration after the
 * first. If the schedule or monitoring mode itself changes mid live-solve —
 * for example couponFrequency changes, or barrierType flips from european to
 * american — this key changes. The raw paths still hit, unaffected, and
 * observables recompute from them.
 */
export function computeObservablesKey(pathKey: string, grid: PricingGrid, requirements: ObservablesRequirements): string {
  return `${pathKey}|obs:${stableStringify({
    couponObs: grid.couponObs,
    callObs: grid.callObs,
    needsMin: requirements.needsMin,
    needsMax: requirements.needsMax,
  })}`;
}

/**
 * Single-entry cache of the driving normals (Box-Muller output). This cache
 * is separate from the raw-path cache above, and its key deliberately
 * excludes market data. Normals depend only on (seed, numPaths, antithetic,
 * nSteps). The mulberry32 stream is seeded per-slice (`seed + s*7919`, the
 * same derivation as the raw cache), and each pair or single draws `nSteps`
 * values in sequence, exactly as `PathBatchGenerator` draws them live (see
 * gbm.ts). A spot, vol, rate, or dividend edit, or a greeks bump, changes
 * `computeCacheKey` (which embeds market) but NOT this key. So those cases
 * hit here even on a raw-path miss: path generation then skips Box-Muller
 * entirely, and re-runs only `fillPath`'s cheap `exp` stepping loop.
 *
 * This cache is bounded the same way as the raw-path cache: a single
 * logical key, evict-and-replace on mismatch. At 100k paths and 252 steps
 * (antithetic, 50k pairs), this is about 50,000 × 252 × 8 bytes, roughly
 * 100MB, on top of the raw-path cache's own roughly 200MB when both are
 * populated for the same run.
 */
interface NormalsCacheEntry {
  key: string;
  slices: (ZSlice | undefined)[];
}

let normalsEntry: NormalsCacheEntry | null = null;

export interface NormalsKeyParams {
  numPaths: number;
  seed: number;
  antithetic: boolean;
  nSteps: number;
  /** Draws per step: one per basket leg, so 1 for a single underlying. A slice
   * drawn for one leg count has the wrong LENGTH for another and must not be
   * replayed across them. */
  drawsPerStep?: number;
}

/** Cache key for the normals cache. It deliberately excludes market data
 * (spot, vol, rate, div, quanto) and the grid's actual step-time values.
 * Normals do not depend on either. They depend only on how many values are
 * drawn, and in what shape (see module doc above). */
export function computeNormalsKey(p: NormalsKeyParams): string {
  return stableStringify({
    numPaths: p.numPaths,
    seed: p.seed,
    antithetic: p.antithetic,
    nSteps: p.nSteps,
    drawsPerStep: p.drawsPerStep ?? 1,
  });
}

/** Draws a fresh `ZSlice` via Box-Muller, in exactly the order
 * `PathBatchGenerator` would draw it live. The function consumes one
 * `normals(sliceSeed)` stream, `nSteps` values at a time, once per pair for
 * antithetic mode or once per single path, in ascending index order. This
 * matches `evaluatePathSource`'s consumption counts exactly —
 * `nPairs = Math.max(1, Math.ceil(numPaths / 2))` for pairs, `numPaths` for
 * singles. So the result is bit-identical to the live draw it replaces. */
function generateZSlice(
  sliceSeed: number,
  nSteps: number,
  antithetic: boolean,
  slicePaths: number,
  drawsPerStep = 1,
): ZSlice {
  const draw = normals(sliceSeed);
  // A basket consumes `drawsPerStep` normals per step, one per leg, and
  // `PathBatchGenerator.liveZ` fills its buffer in exactly this order: step by
  // step, legs innermost. At one leg this is `nSteps` draws, the original
  // length and the original order, so a single underlying replays unchanged.
  const perPath = nSteps * drawsPerStep;
  if (antithetic) {
    const nPairs = Math.max(1, Math.ceil(slicePaths / 2));
    const pairs: Float64Array[] = new Array(nPairs);
    for (let p = 0; p < nPairs; p++) {
      const z = new Float64Array(perPath);
      for (let i = 0; i < perPath; i++) z[i] = draw();
      pairs[p] = z;
    }
    return { antithetic: true, pairs };
  }
  const singles: Float64Array[] = new Array(slicePaths);
  for (let p = 0; p < slicePaths; p++) {
    const z = new Float64Array(perPath);
    for (let i = 0; i < perPath; i++) z[i] = draw();
    singles[p] = z;
  }
  return { antithetic: false, singles };
}

/** Fetches the `ZSlice` for (key, sliceIndex), generating and storing it on
 * first access. A key mismatch against the currently cached entry evicts
 * the entry entirely. This is a single-entry cache, the same discipline as
 * the raw-path cache above. */
function getOrCreateZSlice(
  key: string,
  sliceIndex: number,
  sliceSeed: number,
  slicePaths: number,
  antithetic: boolean,
  nSteps: number,
  drawsPerStep = 1,
): ZSlice {
  if (!normalsEntry || normalsEntry.key !== key) {
    normalsEntry = { key, slices: [] };
  }
  const existing = normalsEntry.slices[sliceIndex];
  if (existing) return existing;
  const z = generateZSlice(sliceSeed, nSteps, antithetic, slicePaths, drawsPerStep);
  normalsEntry.slices[sliceIndex] = z;
  return z;
}

/** Replays a previously-stored slice in the exact order it was recorded. */
class ReplayPathSource implements PathSource {
  private pairIdx = 0;
  private singleIdx = 0;
  constructor(private readonly slice: StoredSlice) {}

  nextPair(): { plus: Float64Array; minus: Float64Array } {
    return this.slice.pairs![this.pairIdx++];
  }

  nextSingle(): Float64Array {
    return this.slice.singles![this.singleIdx++];
  }
}

/** Wraps a live `PathBatchGenerator`. It copies, not just streams through,
 * every path the generator produces, so the pass can retain the whole slice
 * afterward. The generator's own buffers get overwritten in place. */
class RecordingPathSource implements PathSource {
  private readonly pairs: { plus: Float64Array; minus: Float64Array }[] = [];
  private readonly singles: Float64Array[] = [];
  constructor(private readonly gen: PathBatchGenerator) {}

  nextPair(): { plus: Float64Array; minus: Float64Array } {
    const { plus, minus } = this.gen.nextPair();
    const copy = { plus: plus.slice(), minus: minus.slice() };
    this.pairs.push(copy);
    return copy;
  }

  nextSingle(): Float64Array {
    const copy = this.gen.nextSingle().slice();
    this.singles.push(copy);
    return copy;
  }

  toStoredSlice(antithetic: boolean): StoredSlice {
    return antithetic ? { antithetic: true, pairs: this.pairs } : { antithetic: false, singles: this.singles };
  }
}

/**
 * Evaluates one "slice" of a cacheable MC run. On a cache hit, the function
 * replays the stored paths for (key, sliceIndex). On a miss, it generates
 * fresh paths with `sliceSeed`, stores a full copy, and evaluates in the
 * same pass. Either way, the aggregation goes through `evaluatePathSource`.
 * So results are numerically identical to an uncached `runMc` call with the
 * same numPaths, seed, antithetic, nSteps, dtYears, s0, and market.
 *
 * A key mismatch against the currently cached entry evicts the entry
 * entirely. This is a single-entry cache.
 */
export function evaluateCachedSlice(
  key: string,
  sliceIndex: number,
  sliceSeed: number,
  slicePaths: number,
  antithetic: boolean,
  nSteps: number,
  stepDt: Float64Array,
  s0: number,
  market: MarketData,
  evaluator: PayoffEvaluator,
  referenceLevelPct?: number,
  normalsKey?: string,
): McRunResult {
  if (!entry || entry.key !== key) {
    entry = { key, slices: [] };
  }

  const agg = new Aggregator();
  const existing = entry.slices[sliceIndex];
  if (existing) {
    evaluatePathSource(new ReplayPathSource(existing), slicePaths, antithetic, evaluator, agg);
    return agg.finalize(false, referenceLevelPct);
  }

  // Raw-path miss: still try the normals cache first (keyed without market
  // data — see computeNormalsKey). This lets a market-only change (spot,
  // vol, rate, or div edit, or a greeks bump) replay already-drawn normals,
  // instead of paying for Box-Muller again. `normalsKey` is optional only so
  // this function keeps working for any caller that does not have one
  // handy. Omitting it just means every call draws fresh normals, the
  // pre-normals-cache behavior.
  const zSlice = normalsKey
    ? getOrCreateZSlice(
        normalsKey,
        sliceIndex,
        sliceSeed,
        slicePaths,
        antithetic,
        nSteps,
        market.basket && market.basket.assets.length >= 2 ? market.basket.assets.length : 1,
      )
    : undefined;
  const gen = new PathBatchGenerator(sliceSeed, nSteps, s0, market, stepDt, zSlice);
  const recorder = new RecordingPathSource(gen);
  evaluatePathSource(recorder, slicePaths, antithetic, evaluator, agg);
  entry.slices[sliceIndex] = recorder.toStoredSlice(antithetic);
  return agg.finalize(false, referenceLevelPct);
}

/** Replays a previously stored observables slice in the exact order it was
 * computed. This order mirrors the raw slice's generation order. */
class ObservablesReplaySource implements PathSource<PathObservables> {
  private pairIdx = 0;
  private singleIdx = 0;
  constructor(private readonly slice: StoredObservablesSlice) {}

  nextPair(): { plus: PathObservables; minus: PathObservables } {
    return this.slice.pairs![this.pairIdx++];
  }

  nextSingle(): PathObservables {
    return this.slice.singles![this.singleIdx++];
  }
}

/** Maps Phase A over an already-stored raw slice, preserving pair/single
 * structure and order exactly. This has no GBM cost, because the paths
 * already exist. */
function computeObservablesSlice(stored: StoredSlice, observables: ObservablesEvaluator): StoredObservablesSlice {
  if (stored.antithetic) {
    return {
      antithetic: true,
      pairs: stored.pairs!.map(({ plus, minus }) => ({ plus: observables(plus), minus: observables(minus) })),
    };
  }
  return { antithetic: false, singles: stored.singles!.map((s) => observables(s)) };
}

/**
 * Split-evaluator counterpart to `evaluateCachedSlice`. It reuses the same
 * single-entry raw-path cache, plus a second single-entry cache of per-path
 * observables (Phase A output), keyed by `observablesKey`.
 *
 * On a raw-path hit plus an observables hit: the function replays cached
 * observables straight into Phase B (`outcome`). No path walk happens at
 * all.
 * On a raw-path hit plus an observables miss (the schedule changed): the
 * function recomputes observables from the already-cached raw paths. This
 * is cheap, because it needs no GBM. Then it evaluates.
 * On a raw-path miss: the function generates and stores raw paths, as
 * `evaluateCachedSlice` does, evaluating via `outcome(observables(spots))`.
 * This composition is exactly the monolithic evaluator's composition (see
 * tests/observables.test.ts). Then the function separately computes and
 * stores observables for future hits.
 *
 * In every case, aggregation goes through `evaluatePathSource` with the same
 * pair/single ordering as the raw-path case. So results are byte-identical
 * to `evaluateCachedSlice` or `runMc` with an equivalent monolithic
 * evaluator.
 */
export function evaluateCachedSliceSplit(
  key: string,
  sliceIndex: number,
  sliceSeed: number,
  slicePaths: number,
  antithetic: boolean,
  nSteps: number,
  stepDt: Float64Array,
  s0: number,
  market: MarketData,
  observablesKey: string,
  observables: ObservablesEvaluator,
  outcome: OutcomeEvaluator,
  referenceLevelPct?: number,
  normalsKey?: string,
): McRunResult {
  if (!entry || entry.key !== key) {
    entry = { key, slices: [] };
  }
  if (entry.obsKey !== observablesKey) {
    entry.obsKey = observablesKey;
    entry.obsSlices = [];
  }

  const agg = new Aggregator();

  const existingObs = entry.obsSlices![sliceIndex];
  if (existingObs) {
    evaluatePathSource(new ObservablesReplaySource(existingObs), slicePaths, antithetic, outcome, agg);
    return agg.finalize(false, referenceLevelPct);
  }

  const existingPaths = entry.slices[sliceIndex];
  if (existingPaths) {
    const obsSlice = computeObservablesSlice(existingPaths, observables);
    entry.obsSlices![sliceIndex] = obsSlice;
    evaluatePathSource(new ObservablesReplaySource(obsSlice), slicePaths, antithetic, outcome, agg);
    return agg.finalize(false, referenceLevelPct);
  }

  // Full miss: generate and store raw paths, evaluating via the exact same
  // composition (outcome ∘ observables) proven equivalent to the monolithic
  // evaluator. So this branch is byte-identical to evaluateCachedSlice's
  // miss path with the monolithic evaluator. It reuses the normals cache the
  // same way evaluateCachedSlice does — see its comment.
  const zSlice = normalsKey
    ? getOrCreateZSlice(
        normalsKey,
        sliceIndex,
        sliceSeed,
        slicePaths,
        antithetic,
        nSteps,
        market.basket && market.basket.assets.length >= 2 ? market.basket.assets.length : 1,
      )
    : undefined;
  const gen = new PathBatchGenerator(sliceSeed, nSteps, s0, market, stepDt, zSlice);
  const recorder = new RecordingPathSource(gen);
  const evaluator: PayoffEvaluator = (spots: Float64Array) => outcome(observables(spots));
  evaluatePathSource(recorder, slicePaths, antithetic, evaluator, agg);
  const storedSlice = recorder.toStoredSlice(antithetic);
  entry.slices[sliceIndex] = storedSlice;
  entry.obsSlices![sliceIndex] = computeObservablesSlice(storedSlice, observables);
  return agg.finalize(false, referenceLevelPct);
}

/** Test-only: reset the module-level singleton caches (raw paths + normals)
 * between test cases. */
export function __clearPathCacheForTests(): void {
  entry = null;
  normalsEntry = null;
}
