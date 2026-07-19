import type { MarketData } from '../model/market';
import { riskNeutralDrift } from '../model/market';
import { normals } from './rng';

/** Daily simulation frequency used throughout the engine. */
export const STEPS_PER_YEAR = 252;

/**
 * Fills `spots` (length nSteps+1) with a single log-Euler GBM path under the
 * risk-neutral measure, driven by the standard normals in `z` (length
 * nSteps). `sign` flips the driving noise for antithetic pairs.
 */
export function fillPath(
  spots: Float64Array,
  s0: number,
  market: MarketData,
  dtYears: number,
  z: Float64Array,
  sign: 1 | -1,
): void {
  const { vol } = market;
  const drift = (riskNeutralDrift(market) - 0.5 * vol * vol) * dtYears;
  const diffCoeff = vol * Math.sqrt(dtYears);
  spots[0] = s0;
  const nSteps = z.length;
  for (let i = 0; i < nSteps; i++) {
    spots[i + 1] = spots[i] * Math.exp(drift + diffCoeff * sign * z[i]);
  }
}

/**
 * Generates antithetic path pairs, reusing preallocated buffers across
 * calls. Callers must fully consume (or copy) the returned arrays before
 * requesting the next pair.
 */
export class PathBatchGenerator {
  readonly nSteps: number;
  private readonly s0: number;
  private readonly market: MarketData;
  private readonly dtYears: number;
  private readonly z: Float64Array;
  private readonly plusBuf: Float64Array;
  private readonly minusBuf: Float64Array;
  private readonly nextNormal: () => number;

  constructor(seed: number, nSteps: number, s0: number, market: MarketData, dtYears: number) {
    this.nSteps = nSteps;
    this.s0 = s0;
    this.market = market;
    this.dtYears = dtYears;
    this.z = new Float64Array(nSteps);
    this.plusBuf = new Float64Array(nSteps + 1);
    this.minusBuf = new Float64Array(nSteps + 1);
    this.nextNormal = normals(seed);
  }

  /** Draws one antithetic pair, filling z once and reusing the two buffers. */
  nextPair(): { plus: Float64Array; minus: Float64Array } {
    for (let i = 0; i < this.nSteps; i++) this.z[i] = this.nextNormal();
    fillPath(this.plusBuf, this.s0, this.market, this.dtYears, this.z, 1);
    fillPath(this.minusBuf, this.s0, this.market, this.dtYears, this.z, -1);
    return { plus: this.plusBuf, minus: this.minusBuf };
  }

  /** Draws a single (non-antithetic) path, reusing the `plus` buffer. */
  nextSingle(): Float64Array {
    for (let i = 0; i < this.nSteps; i++) this.z[i] = this.nextNormal();
    fillPath(this.plusBuf, this.s0, this.market, this.dtYears, this.z, 1);
    return this.plusBuf;
  }
}
