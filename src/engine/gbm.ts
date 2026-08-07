import type { MarketData } from '../model/market';
import { riskNeutralDrift } from '../model/market';
import { rateAt } from './discount';
import { normals } from './rng';

/** Daily simulation frequency used throughout the engine (for products that
 * still need a daily grid — see schedule.ts's `needsDailyPath`). */
export const STEPS_PER_YEAR = 252;

/**
 * Fills `spots`, length nSteps+1, with a single log-Euler GBM path under the
 * risk-neutral measure, driven by the standard normals in `z`, length
 * nSteps. `sign` flips the driving noise for antithetic pairs.
 *
 * `drift` and `diffCoeff` are PER-STEP precomputed arrays, length nSteps,
 * one entry per simulation step, rather than a single scalar. So this same
 * loop works for both a uniform (daily) grid and a non-uniform
 * (adaptive/compact) grid, without any extra branching in the hot path. See
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
 * A pre-drawn slice of driving normals, in the exact order
 * `PathBatchGenerator` would draw them itself (see rng.ts's `normals` and
 * this file's default draw loop). It holds one Float64Array of length
 * `nSteps` per antithetic pair, shared by `plus` and `minus` — the sign
 * flip happens in `fillPath`, not in the draw — or one per single path.
 * Supplying this to `PathBatchGenerator` skips Box-Muller entirely. Normals
 * depend only on (seed, nSteps, antithetic, path count), never on market
 * data. So the same `ZSlice` is valid for any market. See `pathCache.ts`'s
 * normals cache, which produces and caches these.
 */
export interface ZSlice {
  antithetic: boolean;
  pairs?: Float64Array[];
  singles?: Float64Array[];
}

/**
 * Generates antithetic path pairs, reusing preallocated buffers across
 * calls. Callers must fully consume, or copy, the returned arrays before
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
  private readonly nextNormal?: () => number;
  private readonly zSlice?: ZSlice;
  private zIdx = 0;

  /**
   * `stepDt` is either a single scalar — a uniform, daily, grid; every
   * existing call site that only ever priced a daily grid keeps working
   * unchanged — or a per-step Float64Array/number[] of length `nSteps`, a
   * compact, possibly non-uniform, adaptive grid. Either way, `drift[i]`
   * and `diffCoeff[i]` are precomputed ONCE here, never per path. The inner
   * loop in `fillPath` stays one `Math.exp` plus a couple of multiplies,
   * regardless of grid shape.
   *
   * BIT-IDENTITY: the scalar branch computes `drift`/`diffCoeff` exactly
   * once, using the same arithmetic and the same operand order as the
   * pre-adaptive-grid engine, and fills every slot with that identical
   * double via `Float64Array.fill`. So a uniform grid's paths are
   * byte-identical to before this change.
   */
  /**
   * `zSlice`, when provided, replaces live Box-Muller draws with a replay
   * of a pre-drawn normals slice (see `pathCache.ts`'s normals cache).
   * `seed` is then unused for normals; the drift/diffCoeff computation
   * below is unaffected either way. Omitting `zSlice` preserves the exact
   * prior behavior, a live draw from `normals(seed)`. So every existing
   * call site — runMc, lsmc, tests — is untouched and bit-identical.
   */
  constructor(
    seed: number,
    nSteps: number,
    s0: number,
    market: MarketData,
    stepDt: number | Float64Array | number[],
    zSlice?: ZSlice,
  ) {
    this.nSteps = nSteps;
    this.s0 = s0;
    this.plusBuf = new Float64Array(nSteps + 1);
    this.minusBuf = new Float64Array(nSteps + 1);
    if (zSlice) {
      this.zSlice = zSlice;
      this.z = new Float64Array(0);
    } else {
      this.z = new Float64Array(nSteps);
      this.nextNormal = normals(seed);
    }

    const { vol, volPerStep, rateCurve, divYield } = market;
    const borrow = (market.costs?.borrowCostBp ?? 0) / 10_000;
    // The rate curve drives DISCOUNTING and the drift, but only on a
    // single-currency note. `rateCurve` holds the NOTE currency's zero
    // curve. A quanto note's underlying grows at the UNDERLYING currency's
    // rate, `quanto.rateUnderlying`, with the equity-FX correlation
    // correction that `riskNeutralDrift` applies. Feeding the note curve
    // into the drift makes two errors at once: it substitutes the wrong
    // currency's rate, and it drops the correlation term. So the drift
    // ignores the curve whenever the note is quanto, exactly as
    // MarketData.rateCurve's doc states. Discounting still uses the curve,
    // because a quanto note discounts on the note currency.
    const driftUsesCurve = !!rateCurve && rateCurve.length > 0 && !market.quanto;
    const muDt = riskNeutralDrift(market) - 0.5 * vol * vol;
    this.drift = new Float64Array(nSteps);
    this.diffCoeff = new Float64Array(nSteps);

    // Per-step drift needs each step's start time, for the rate curve's
    // forward rates and for the vol schedule's midpoints (cumulative
    // times of the grid, computed once here, never per path).
    const stepStartTimes = (() => {
      const out = new Float64Array(nSteps);
      let t = 0;
      if (typeof stepDt === 'number') {
        for (let i = 0; i < nSteps; i++) {
          out[i] = t;
          t += stepDt;
        }
      } else {
        for (let i = 0; i < nSteps; i++) {
          out[i] = t;
          t += stepDt[i];
        }
      }
      return out;
    })();

    if (volPerStep) {
      // Piecewise-constant vol across the path: step i diffuses at
      // volPerStep[i]. The drift's Ito correction uses the step's own vol
      // too, (mu - 0.5*v_i^2) per step, so the log-Euler step stays exact
      // for the piecewise-constant-vol model. The quanto correlation term
      // inside riskNeutralDrift keeps the single flat `vol` — a cross-asset
      // covariance anchor, see MarketData.volPerStep's doc.
      //
      // BIT-IDENTITY: when every volPerStep[i] equals `vol` and no rate
      // curve is set, each (riskNeutralDrift - 0.5*v_i^2) is the same double
      // as the scalar branch's muDt (identical operand order), so a constant
      // per-step array reproduces the flat-vol engine byte for byte. A
      // constant array is exactly what a term-structure-free surface
      // produces.
      //
      // With a rate curve too, the drift composes: the curve's forward rate
      // for the step replaces the flat `rate` (the same substitution the
      // curve-only branch below makes), on top of the per-step vol.
      const hasCurve = driftUsesCurve;
      const q = divYield;
      if (volPerStep.length !== nSteps) {
        throw new Error(`volPerStep has ${volPerStep.length} entries for ${nSteps} steps`);
      }
      const driftPerStep = (i: number, dt: number): number => {
        const v = volPerStep[i];
        const base = hasCurve
          ? (() => {
              const t1 = stepStartTimes[i];
              const t2 = t1 + dt;
              return (rateAt(rateCurve!, t2) * t2 - rateAt(rateCurve!, t1) * t1) / dt - q - borrow;
            })()
          : riskNeutralDrift(market);
        return (base - 0.5 * v * v) * dt;
      };
      if (typeof stepDt === 'number') {
        for (let i = 0; i < nSteps; i++) {
          const v = volPerStep[i];
          this.drift[i] = driftPerStep(i, stepDt);
          this.diffCoeff[i] = v * Math.sqrt(stepDt);
        }
      } else {
        for (let i = 0; i < nSteps; i++) {
          const v = volPerStep[i];
          this.drift[i] = driftPerStep(i, stepDt[i]);
          this.diffCoeff[i] = v * Math.sqrt(stepDt[i]);
        }
      }
      return;
    }

    if (driftUsesCurve && rateCurve) {
      // Rate-curve drift: the risk-neutral drift at step i uses the
      // INSTANTANEOUS FORWARD rate of that step, not the zero rate. The
      // curve's points are zero rates z(t), so the discount factor of a
      // cashflow at t is exp(-z(t)*t). The drift must run on the same
      // curve: E[S_{t2}/S_{t1}] = exp(integral of forward) = exp(z(t2)*t2 -
      // z(t1)*t1), which telescopes to exp(z(T)*T - q*T) over the whole
      // path. That is what makes the curve cancel out of the forward:
      // E[S_T]*df(T) = S0*exp(-q*T), exactly as with a flat rate. With a
      // piecewise-linear zero curve, the average forward over a step is
      // (z(t2)*t2 - z(t1)*t1)/(t2 - t1), exact — no quadrature. A quanto
      // note never reaches this branch: `driftUsesCurve` excludes it, so
      // the quanto drift keeps the flat underlying rate.
      const q = divYield;
      if (typeof stepDt === 'number') {
        const dt = stepDt;
        for (let i = 0; i < nSteps; i++) {
          const t1 = stepStartTimes[i];
          const t2 = t1 + dt;
          const fwd = (rateAt(rateCurve, t2) * t2 - rateAt(rateCurve, t1) * t1) / dt;
          this.drift[i] = (fwd - q - borrow - 0.5 * vol * vol) * dt;
          this.diffCoeff[i] = vol * Math.sqrt(dt);
        }
      } else {
        for (let i = 0; i < nSteps; i++) {
          const t1 = stepStartTimes[i];
          const t2 = t1 + stepDt[i];
          const fwd = (rateAt(rateCurve, t2) * t2 - rateAt(rateCurve, t1) * t1) / stepDt[i];
          this.drift[i] = (fwd - q - borrow - 0.5 * vol * vol) * stepDt[i];
          this.diffCoeff[i] = vol * Math.sqrt(stepDt[i]);
        }
      }
      return;
    }

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

  /** Draws one antithetic pair, filling z once and reusing the two buffers.
   * When constructed with a `zSlice`, replays the next stored z instead of
   * drawing, with no Box-Muller. Either way, the `fillPath` call is the
   * same. */
  nextPair(): { plus: Float64Array; minus: Float64Array } {
    const z = this.zSlice ? this.zSlice.pairs![this.zIdx++] : this.liveZ();
    fillPath(this.plusBuf, this.s0, this.drift, this.diffCoeff, z, 1);
    fillPath(this.minusBuf, this.s0, this.drift, this.diffCoeff, z, -1);
    return { plus: this.plusBuf, minus: this.minusBuf };
  }

  /** Draws a single (non-antithetic) path, reusing the `plus` buffer. */
  nextSingle(): Float64Array {
    const z = this.zSlice ? this.zSlice.singles![this.zIdx++] : this.liveZ();
    fillPath(this.plusBuf, this.s0, this.drift, this.diffCoeff, z, 1);
    return this.plusBuf;
  }

  /** Draws nSteps fresh normals into the reusable `z` buffer. Live mode
   * only — see constructor. */
  private liveZ(): Float64Array {
    for (let i = 0; i < this.nSteps; i++) this.z[i] = this.nextNormal!();
    return this.z;
  }
}
