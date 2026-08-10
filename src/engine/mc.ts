import type { MarketData } from '../model/market';
import type { Diagnostics } from '../model/request';
import { PathBatchGenerator } from './gbm';
import type { PayoffEvaluator, PathOutcome } from './payoffs/types';
import { computeExpectedShortfall, computeHistogram, computePLoss } from './distribution';

export interface McOptions {
  numPaths: number;
  seed: number;
  antithetic: boolean;
  nSteps: number;
  /**
   * Year fraction of one grid step. Either a single scalar — a uniform
   * grid; required for correct GBM stepping when tenorYears/nSteps
   * deviates from 1/252, for example sub-daily tenors clamped to nSteps=1
   * — or a per-step Float64Array/number[] of length nSteps, a compact or
   * adaptive, possibly non-uniform, grid (see schedule.ts's buildGrid).
   * Defaults to 1/252 if omitted.
   */
  dtYears?: number | Float64Array | number[];
  s0: number;
  market: MarketData;
  evaluator: PayoffEvaluator;
  batchSize?: number;
  /** Called between batches with the number of individual paths simulated
   * so far. Return false to cancel the run. */
  onBatch?: (pathsDone: number) => boolean;
  /**
   * When provided, enables distribution diagnostics — histogram, pLoss,
   * ES — in the returned result, computed against this PV% reference
   * level, for example issuePricePct. Omit to skip this small but
   * non-zero extra work.
   */
  referenceLevelPct?: number;
}

export interface McRunResult {
  pvPct: number;
  stderrPct: number;
  cancelled: boolean;
  diagnostics: Diagnostics;
  /** One float per PATH, the outcome distribution. Not the pair averages the
   * mean is built from — see Aggregator.addDistributionSample. Callers that
   * combine multiple runs, for example sliced pricing, can concatenate these
   * for a global distribution view, instead of trusting any single run's
   * histogram. Empty when the run was told to keep no samples. */
  samples: Float64Array;
}

const DEFAULT_BATCH_PAIRS = 5000;

/** Shared empty buffer, so an aggregator that keeps no samples allocates
 * nothing at all. */
const EMPTY_SAMPLES = new Float64Array(0);

export class Aggregator {
  sampleSum = 0;
  sampleSumSq = 0;
  nSamples = 0;
  /**
   * Every sample, kept ONLY when the distribution diagnostics will ask for
   * them. The mean and the standard error come from the running sums above,
   * so they never need this list.
   *
   * WHY IT IS CONDITIONAL: the histogram, the loss probability and the
   * expected shortfall are the only readers, and they run only when
   * `finalize` gets a `referenceLevelPct`. Collecting unconditionally pushed
   * 50k numbers per pass and grew the backing array by repeated doubling. A
   * solve does that four times over and throws all four away.
   */
  samples: Float64Array = EMPTY_SAMPLES;
  private nKept = 0;

  /**
   * `keepSamples` must be true whenever `finalize` will be given a
   * `referenceLevelPct`. The caller always knows that before it builds the
   * aggregator, because it is the same value it will pass on.
   *
   * `capacity` is how many samples will arrive: one per path. Sizing the
   * buffer once matters more than it looks. A plain array grown by repeated
   * push doubles its backing store about seventeen times on the way to 100k,
   * copying everything each time, and that alone was 44 ms of a 59 ms warm
   * reprice. A Float64Array allocated once holds the same numbers in one
   * eighth of the memory with no copying at all. An arrival past the stated
   * capacity is dropped rather than allowed to grow the buffer, so a wrong
   * hint costs accuracy in the diagnostics and never a reallocation. Callers
   * pass the path count they are about to run.
   */
  constructor(keepSamples = true, capacity = 0) {
    if (keepSamples && capacity > 0) this.samples = new Float64Array(capacity);
  }

  totalPaths = 0;
  callCounts: number[] = [];
  kiCount = 0;
  upsideKoCount = 0;
  koCount = 0;
  lifeYearsSum = 0;

  /** Records one pricing sample (a single path, or the average of an
   * antithetic pair) for the mean/stderr estimate. */
  addSample(pvPct: number): void {
    this.sampleSum += pvPct;
    this.sampleSumSq += pvPct * pvPct;
    this.nSamples += 1;
  }

  /**
   * Records ONE INDIVIDUAL PATH's value for the outcome distribution.
   *
   * WHY THIS IS SEPARATE FROM `addSample`. Antithetic sampling averages a
   * path with its mirror image, and that average is the right estimator for
   * the mean and the standard error. It is the wrong object for the tail. A
   * knocked-in path that redeems at 55 and its mirror that redeems at 100 plus
   * coupons average to something near par, so the pair never lands in the loss
   * region at all. Feeding those averages to the histogram, to P(loss) and to
   * Expected Shortfall reported a note that cannot lose money. Those three
   * numbers are the ones a client reads as risk, so they must describe paths
   * the note can actually take.
   *
   * The mean of these samples still equals the mean of the pair averages, so
   * nothing about the price changes.
   */
  addDistributionSample(pvPct: number): void {
    if (this.nKept < this.samples.length) this.samples[this.nKept++] = pvPct;
  }

  /** Records diagnostics for one individual simulated path. */
  addPathDiagnostics(outcome: PathOutcome): void {
    this.totalPaths += 1;
    if (outcome.calledAtPeriod !== undefined) {
      const idx = outcome.calledAtPeriod - 1;
      while (this.callCounts.length <= idx) this.callCounts.push(0);
      this.callCounts[idx] += 1;
    }
    if (outcome.kiEvent) this.kiCount += 1;
    if (outcome.upsideKoEvent) this.upsideKoCount += 1;
    if (outcome.koEvent) this.koCount += 1;
    this.lifeYearsSum += outcome.lifeYears;
  }

  finalize(cancelled: boolean, referenceLevelPct?: number): McRunResult {
    const mean = this.nSamples > 0 ? this.sampleSum / this.nSamples : 0;
    let stderrPct = 0;
    if (this.nSamples > 1) {
      const variance = Math.max(
        0,
        (this.sampleSumSq / this.nSamples - mean * mean) * (this.nSamples / (this.nSamples - 1)),
      );
      stderrPct = Math.sqrt(variance / this.nSamples);
    }

    const denom = this.totalPaths > 0 ? this.totalPaths : 1;
    const diagnostics: Diagnostics = {
      callProb: this.callCounts.map((c) => c / denom),
      kiProb: this.kiCount / denom,
      upsideKoProb: this.upsideKoCount / denom,
      koProb: this.koCount / denom,
      expectedLifeYears: this.lifeYearsSum / denom,
    };

    // Trim to what actually arrived. A cancelled run stops early, and the
    // untouched tail of the buffer is zeros, which would drag every statistic
    // toward zero if it were counted.
    const samples = this.nKept === this.samples.length ? this.samples : this.samples.subarray(0, this.nKept);

    if (referenceLevelPct !== undefined && samples.length > 0) {
      diagnostics.histogram = computeHistogram(samples);
      diagnostics.pLoss = computePLoss(samples, referenceLevelPct);
      diagnostics.expectedShortfall5 = computeExpectedShortfall(samples, 0.05);
      diagnostics.expectedShortfall1 = computeExpectedShortfall(samples, 0.01);
    }

    return { pvPct: mean, stderrPct, cancelled, diagnostics, samples };
  }
}

/**
 * Anything that can hand out the next path, or antithetic pair, on demand.
 * `PathBatchGenerator` satisfies this structurally, with streaming, fresh
 * RNG draws. A cache-backed source can satisfy it too, by replaying
 * previously generated paths. Either way, `evaluatePathSource` below does
 * the exact same aggregation. So results are identical regardless of where
 * the paths came from.
 *
 * Generic over the item type `T`, so the same replay-and-aggregation
 * machinery works both for raw paths (`T = Float64Array`, the classic
 * case) and for cached per-path observables (`T = PathObservables`, see
 * pathCache.ts). The aggregation logic — pairing, batching,
 * addSample/addPathDiagnostics order — is identical either way. This is
 * exactly what keeps an observables-cache hit byte-identical to evaluating
 * straight from spots.
 */
export interface PathSource<T = Float64Array> {
  nextPair(): { plus: T; minus: T };
  nextSingle(): T;
}

/**
 * Pulls `numPaths` paths, or antithetic pairs, from `source`, evaluates
 * each with `evaluator`, and folds the outcomes into `agg`. This is the
 * one place path-evaluation and aggregation happens. `runMc` (streaming
 * generation) and the worker's path cache (generate-once-and-replay) both
 * funnel through it. So a cache hit is numerically identical to a fresh
 * run. Returns true if `onBatch` requested cancellation.
 */
export function evaluatePathSource<T = Float64Array>(
  source: PathSource<T>,
  numPaths: number,
  antithetic: boolean,
  evaluator: (item: T) => PathOutcome,
  agg: Aggregator,
  batchSize: number = DEFAULT_BATCH_PAIRS,
  onBatch?: (pathsDone: number) => boolean,
): boolean {
  let cancelled = false;

  if (antithetic) {
    const nPairs = Math.max(1, Math.ceil(numPaths / 2));
    let pairsDone = 0;
    while (pairsDone < nPairs) {
      const batchPairs = Math.min(batchSize, nPairs - pairsDone);
      for (let i = 0; i < batchPairs; i++) {
        const { plus, minus } = source.nextPair();
        const outPlus = evaluator(plus);
        const outMinus = evaluator(minus);
        agg.addSample((outPlus.pvPct + outMinus.pvPct) / 2);
        // The pair average estimates the mean. The two paths, separately, are
        // the outcome distribution. See addDistributionSample.
        agg.addDistributionSample(outPlus.pvPct);
        agg.addDistributionSample(outMinus.pvPct);
        agg.addPathDiagnostics(outPlus);
        agg.addPathDiagnostics(outMinus);
      }
      pairsDone += batchPairs;
      if (onBatch && !onBatch(pairsDone * 2)) {
        cancelled = true;
        break;
      }
    }
  } else {
    let pathsDone = 0;
    while (pathsDone < numPaths) {
      const batchN = Math.min(batchSize, numPaths - pathsDone);
      for (let i = 0; i < batchN; i++) {
        const path = source.nextSingle();
        const out = evaluator(path);
        agg.addSample(out.pvPct);
        agg.addDistributionSample(out.pvPct);
        agg.addPathDiagnostics(out);
      }
      pathsDone += batchN;
      if (onBatch && !onBatch(pathsDone)) {
        cancelled = true;
        break;
      }
    }
  }

  return cancelled;
}

export function runMc(opts: McOptions): McRunResult {
  const {
    numPaths,
    seed,
    antithetic,
    nSteps,
    dtYears = 1 / 252,
    s0,
    market,
    evaluator,
    batchSize = DEFAULT_BATCH_PAIRS,
    onBatch,
    referenceLevelPct,
  } = opts;

  const agg = new Aggregator(referenceLevelPct !== undefined, numPaths);
  const gen = new PathBatchGenerator(seed, nSteps, s0, market, dtYears);
  const cancelled = evaluatePathSource(gen, numPaths, antithetic, evaluator, agg, batchSize, onBatch);

  return agg.finalize(cancelled, referenceLevelPct);
}
