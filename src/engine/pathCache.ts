/**
 * Single-entry cache of raw simulated GBM paths, scoped to the worker
 * module (a module-level singleton — persists across `executePriceRequest`
 * calls within the same worker instance, not per-request).
 *
 * Path *generation* (GBM stepping) is the expensive part of MC pricing;
 * payoff *evaluation* is comparatively cheap. Generated paths depend only on
 * market data, MC settings (numPaths/seed/antithetic), and the path grid
 * shape (nSteps/dtYears) — not on product terms (strikes/barriers/coupons).
 * So during a solve-for (many `priceOnce` calls, same market+mc+tenor, only
 * the product spec changing) the same raw paths can be reused across every
 * iteration, re-running only the cheap evaluator.
 *
 * Capped at a single key (evict-and-replace on any mismatch) to bound
 * memory: 100k paths × ~253 steps × 8 bytes ≈ 200MB is already a lot to
 * hold once; multiple entries would multiply that.
 *
 * `runMc` (streaming, no retention) is untouched by this module — it stays
 * the small/serial/test-facing API. This cache is a worker-side optimization
 * layered on top via `evaluatePathSource`, so cache hits are byte-identical
 * to a fresh `runMc` run of the same spec.
 */
import type { MarketData } from '../model/market';
import { PathBatchGenerator } from './gbm';
import { Aggregator, evaluatePathSource } from './mc';
import type { McRunResult, PathSource } from './mc';
import type { ObservablesEvaluator, OutcomeEvaluator, PathObservables, PayoffEvaluator, PricingGrid } from './payoffs/types';

interface StoredSlice {
  antithetic: boolean;
  pairs?: { plus: Float64Array; minus: Float64Array }[];
  singles?: Float64Array[];
}

/** Same shape as StoredSlice but holding cached per-path observables instead
 * of raw spots — the "handful of floats each" that Phase A produces. */
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
  dtYears: number;
}

/** Cache key: market data + MC settings + grid shape — everything path
 * generation depends on, and nothing product-specific. */
export function computeCacheKey(p: CacheKeyParams): string {
  return stableStringify({
    spot: p.s0,
    vol: p.market.vol,
    rate: p.market.rate,
    divYield: p.market.divYield,
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
    dtYears: p.dtYears,
  });
}

/**
 * Observables depend on the raw paths (already covered by `computeCacheKey`)
 * plus the observation index sets (grid.couponObs / grid.callObs) — NOT on
 * any numeric spec parameter. During a typical solve the schedule is fixed
 * (only barrier/coupon levels change) so this key stays constant and
 * observables hit on every iteration after the first; if the schedule itself
 * changes (e.g. couponFrequency changes mid live-solve), this key changes,
 * the raw paths still hit (unaffected), and observables recompute from them.
 */
export function computeObservablesKey(pathKey: string, grid: PricingGrid): string {
  return `${pathKey}|obs:${stableStringify({ couponObs: grid.couponObs, callObs: grid.callObs })}`;
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

/** Wraps a live `PathBatchGenerator`, copying (not just streaming-through)
 * every path it produces so the whole slice can be retained after this
 * pass — the generator's own buffers are overwritten in place. */
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
 * Evaluates one "slice" of a cacheable MC run: on a cache hit, replays the
 * stored paths for (key, sliceIndex); on a miss, generates them fresh (with
 * `sliceSeed`), stores a full copy, and evaluates in the same pass. Either
 * way the aggregation goes through `evaluatePathSource`, so results are
 * numerically identical to an uncached `runMc` call with the same
 * numPaths/seed/antithetic/nSteps/dtYears/s0/market.
 *
 * A key mismatch against the currently-cached entry evicts it entirely
 * (single-entry cache).
 */
export function evaluateCachedSlice(
  key: string,
  sliceIndex: number,
  sliceSeed: number,
  slicePaths: number,
  antithetic: boolean,
  nSteps: number,
  dtYears: number,
  s0: number,
  market: MarketData,
  evaluator: PayoffEvaluator,
  referenceLevelPct?: number,
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

  const gen = new PathBatchGenerator(sliceSeed, nSteps, s0, market, dtYears);
  const recorder = new RecordingPathSource(gen);
  evaluatePathSource(recorder, slicePaths, antithetic, evaluator, agg);
  entry.slices[sliceIndex] = recorder.toStoredSlice(antithetic);
  return agg.finalize(false, referenceLevelPct);
}

/** Replays a previously-stored observables slice in the exact order it was
 * computed (which mirrors the raw slice's generation order). */
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
 * structure and order exactly (no GBM cost — the paths already exist). */
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
 * Split-evaluator counterpart to `evaluateCachedSlice`: reuses the same
 * single-entry raw-path cache, plus a second single-entry cache of per-path
 * observables (Phase A output) keyed by `observablesKey`.
 *
 * On a raw-path hit + observables hit: replays cached observables straight
 * into Phase B (`outcome`) — no path walk at all.
 * On a raw-path hit + observables miss (schedule changed): recomputes
 * observables from the already-cached raw paths (cheap — no GBM), then
 * evaluates.
 * On a raw-path miss: generates + stores raw paths (as `evaluateCachedSlice`
 * does), evaluating via `outcome(observables(spots))` — which is exactly the
 * monolithic evaluator's composition (see tests/observables.test.ts) — then
 * separately computes and stores observables for future hits.
 *
 * Either way, aggregation goes through `evaluatePathSource` with the same
 * pair/single ordering as the raw-path case, so results are byte-identical
 * to `evaluateCachedSlice`/`runMc` with an equivalent monolithic evaluator.
 */
export function evaluateCachedSliceSplit(
  key: string,
  sliceIndex: number,
  sliceSeed: number,
  slicePaths: number,
  antithetic: boolean,
  nSteps: number,
  dtYears: number,
  s0: number,
  market: MarketData,
  observablesKey: string,
  observables: ObservablesEvaluator,
  outcome: OutcomeEvaluator,
  referenceLevelPct?: number,
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

  // Full miss: generate + store raw paths, evaluating via the exact same
  // composition (outcome ∘ observables) proven equivalent to the monolithic
  // evaluator, so this branch is byte-identical to evaluateCachedSlice's
  // miss path with the monolithic evaluator.
  const gen = new PathBatchGenerator(sliceSeed, nSteps, s0, market, dtYears);
  const recorder = new RecordingPathSource(gen);
  const evaluator: PayoffEvaluator = (spots: Float64Array) => outcome(observables(spots));
  evaluatePathSource(recorder, slicePaths, antithetic, evaluator, agg);
  const storedSlice = recorder.toStoredSlice(antithetic);
  entry.slices[sliceIndex] = storedSlice;
  entry.obsSlices![sliceIndex] = computeObservablesSlice(storedSlice, observables);
  return agg.finalize(false, referenceLevelPct);
}

/** Test-only: reset the module-level singleton cache between test cases. */
export function __clearPathCacheForTests(): void {
  entry = null;
}
