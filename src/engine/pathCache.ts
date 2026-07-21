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
import type { PayoffEvaluator } from './payoffs/types';

interface StoredSlice {
  antithetic: boolean;
  pairs?: { plus: Float64Array; minus: Float64Array }[];
  singles?: Float64Array[];
}

interface CacheEntry {
  key: string;
  slices: (StoredSlice | undefined)[];
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

/** Test-only: reset the module-level singleton cache between test cases. */
export function __clearPathCacheForTests(): void {
  entry = null;
}
