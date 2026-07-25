import type { MarketData } from '../model/market';
import { riskNeutralDrift } from '../model/market';
import { normals } from './rng';

/** Daily simulation frequency used throughout the engine (for products that
 * still need a daily grid — see schedule.ts's `needsDailyPath`). */
export const STEPS_PER_YEAR = 252;

/**
 * Fills `spots` (length nSteps+1) with a single log-Euler GBM path under the
 * risk-neutral measure, driven by the standard normals in `z` (length
 * nSteps). `sign` flips the driving noise for antithetic pairs.
 *
 * `drift`/`diffCoeff` are PER-STEP precomputed arrays (length nSteps, one
 * entry per simulation step) rather than a single scalar, so this same loop
 * works for both a uniform (daily) grid and a non-uniform (adaptive/compact)
 * grid without any extra branching in the hot path — see
 * `PathBatchGenerator`'s constructor, which computes these arrays ONCE, not
 * per path.
 */
export function fillPath(
  spots: Float64Array,
  s0: number,
  drift: Float64Array,
  diffCoeff: Float64Array,
  z: Float64Array,
  sign: 1 | -1,
): void {
  spots[0] = s0;
  const nSteps = z.length;
  for (let i = 0; i < nSteps; i++) {
    spots[i + 1] = spots[i] * Math.exp(drift[i] + diffCoeff[i] * sign * z[i]);
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
  private readonly drift: Float64Array;
  private readonly diffCoeff: Float64Array;
  private readonly z: Float64Array;
  private readonly plusBuf: Float64Array;
  private readonly minusBuf: Float64Array;
  private readonly nextNormal: () => number;

  /**
   * `stepDt` is either a single scalar (uniform/daily grid — every existing
   * call site that only ever priced a daily grid keeps working unchanged)
   * or a per-step Float64Array/number[] of length `nSteps` (a compact,
   * possibly non-uniform adaptive grid). Either way, `drift[i]`/
   * `diffCoeff[i]` are precomputed ONCE here, never per path — the inner
   * loop in `fillPath` stays one `Math.exp` plus a couple of multiplies
   * regardless of grid shape.
   *
   * BIT-IDENTITY: the scalar branch computes `drift`/`diffCoeff` exactly
   * once (same arithmetic, same operand order as the pre-adaptive-grid
   * engine) and fills every slot with that identical double via
   * `Float64Array.fill`, so a uniform grid's paths are byte-identical to
   * before this change.
   */
  constructor(
    seed: number,
    nSteps: number,
    s0: number,
    market: MarketData,
    stepDt: number | Float64Array | number[],
  ) {
    this.nSteps = nSteps;
    this.s0 = s0;
    this.z = new Float64Array(nSteps);
    this.plusBuf = new Float64Array(nSteps + 1);
    this.minusBuf = new Float64Array(nSteps + 1);
    this.nextNormal = normals(seed);

    const { vol } = market;
    const muDt = riskNeutralDrift(market) - 0.5 * vol * vol;
    this.drift = new Float64Array(nSteps);
    this.diffCoeff = new Float64Array(nSteps);

    if (typeof stepDt === 'number') {
      const drift = muDt * stepDt;
      const diffCoeff = vol * Math.sqrt(stepDt);
      this.drift.fill(drift);
      this.diffCoeff.fill(diffCoeff);
    } else {
      for (let i = 0; i < nSteps; i++) {
        this.drift[i] = muDt * stepDt[i];
        this.diffCoeff[i] = vol * Math.sqrt(stepDt[i]);
      }
    }
  }

  /** Draws one antithetic pair, filling z once and reusing the two buffers. */
  nextPair(): { plus: Float64Array; minus: Float64Array } {
    for (let i = 0; i < this.nSteps; i++) this.z[i] = this.nextNormal();
    fillPath(this.plusBuf, this.s0, this.drift, this.diffCoeff, this.z, 1);
    fillPath(this.minusBuf, this.s0, this.drift, this.diffCoeff, this.z, -1);
    return { plus: this.plusBuf, minus: this.minusBuf };
  }

  /** Draws a single (non-antithetic) path, reusing the `plus` buffer. */
  nextSingle(): Float64Array {
    for (let i = 0; i < this.nSteps; i++) this.z[i] = this.nextNormal();
    fillPath(this.plusBuf, this.s0, this.drift, this.diffCoeff, this.z, 1);
    return this.plusBuf;
  }
}
