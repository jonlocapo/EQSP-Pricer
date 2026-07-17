import type { MarketData } from '../model/market';
import type { Diagnostics } from '../model/request';
import { PathBatchGenerator } from './gbm';
import type { PayoffEvaluator, PathOutcome } from './payoffs/types';

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
}

export interface McRunResult {
  pvPct: number;
  stderrPct: number;
  cancelled: boolean;
  diagnostics: Diagnostics;
}

const DEFAULT_BATCH_PAIRS = 5000;

class Aggregator {
  sampleSum = 0;
  sampleSumSq = 0;
  nSamples = 0;

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

  finalize(cancelled: boolean): McRunResult {
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

    return { pvPct: mean, stderrPct, cancelled, diagnostics };
  }
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
  } = opts;

  const agg = new Aggregator();
  const gen = new PathBatchGenerator(seed, nSteps, s0, market, dtYears);

  let cancelled = false;

  if (antithetic) {
    const nPairs = Math.max(1, Math.ceil(numPaths / 2));
    let pairsDone = 0;
    while (pairsDone < nPairs) {
      const batchPairs = Math.min(batchSize, nPairs - pairsDone);
      for (let i = 0; i < batchPairs; i++) {
        const { plus, minus } = gen.nextPair();
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
        const path = gen.nextSingle();
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

  return agg.finalize(cancelled);
}
