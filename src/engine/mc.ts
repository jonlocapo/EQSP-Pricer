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
  /** Year fraction of one grid step (grid.dtYears). Not listed in the
   * original spec's option set but required for correct GBM stepping when
   * tenorYears/nSteps deviates from 1/252 (e.g. sub-daily tenors clamped to
   * nSteps=1). Defaults to 1/252 if omitted. */
  dtYears?: number;
  s0: number;
  market: MarketData;
  evaluator: PayoffEvaluator;
  batchSize?: number;
  /** Called between batches with the number of individual paths simulated
   * so far. Return false to cancel the run. */
  onBatch?: (pathsDone: number) => boolean;
  /**
   * When provided, enables distribution diagnostics (histogram/pLoss/ES) in
   * the returned result, computed against this PV% reference level (e.g.
   * issuePricePct). Omit to skip the (small but non-zero) extra work.
   */
  referenceLevelPct?: number;
}

export interface McRunResult {
  pvPct: number;
  stderrPct: number;
  cancelled: boolean;
  diagnostics: Diagnostics;
  /** One float per recorded sample (per path, or per antithetic pair —
   * matches Aggregator.addSample's unit). Callers that combine multiple
   * runs (e.g. sliced pricing) can concatenate these for a global
   * distribution view rather than trusting any single run's histogram. */
  samples: number[];
}

const DEFAULT_BATCH_PAIRS = 5000;

export class Aggregator {
  sampleSum = 0;
  sampleSumSq = 0;
  nSamples = 0;
  samples: number[] = [];

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
    this.samples.push(pvPct);
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

    if (referenceLevelPct !== undefined && this.samples.length > 0) {
      diagnostics.histogram = computeHistogram(this.samples);
      diagnostics.pLoss = computePLoss(this.samples, referenceLevelPct);
      diagnostics.expectedShortfall5 = computeExpectedShortfall(this.samples, 0.05);
      diagnostics.expectedShortfall1 = computeExpectedShortfall(this.samples, 0.01);
    }

    return { pvPct: mean, stderrPct, cancelled, diagnostics, samples: this.samples };
  }
}

/**
 * Anything that can hand out the next path (or antithetic pair) on demand.
 * `PathBatchGenerator` satisfies this structurally (streaming, fresh RNG
 * draws); a cache-backed source can satisfy it too by replaying previously
 * generated paths — either way `evaluatePathSource` below does the exact
 * same aggregation, so results are identical regardless of where the paths
 * came from.
 */
export interface PathSource {
  nextPair(): { plus: Float64Array; minus: Float64Array };
  nextSingle(): Float64Array;
}

/**
 * Pulls `numPaths` paths (or antithetic pairs) from `source`, evaluates each
 * with `evaluator`, and folds the outcomes into `agg`. This is the one
 * place path-evaluation + aggregation happens — `runMc` (streaming
 * generation) and the worker's path cache (generate-once-and-replay) both
 * funnel through it so a cache hit is numerically identical to a fresh run.
 * Returns true if `onBatch` requested cancellation.
 */
export function evaluatePathSource(
  source: PathSource,
  numPaths: number,
  antithetic: boolean,
  evaluator: PayoffEvaluator,
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

  const agg = new Aggregator();
  const gen = new PathBatchGenerator(seed, nSteps, s0, market, dtYears);
  const cancelled = evaluatePathSource(gen, numPaths, antithetic, evaluator, agg, batchSize, onBatch);

  return agg.finalize(cancelled, referenceLevelPct);
}
