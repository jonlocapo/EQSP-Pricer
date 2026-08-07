import type { MarketData } from '../model/market';
import { riskNeutralDrift } from '../model/market';
import { rateAt } from './discount';
import { choleskyLower } from '../model/correlation';
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
 * Fills `out`, length nSteps+1, with a WORST-OF path: at each step, the lowest
 * performance across the basket's legs, scaled by `s0`.
 *
 * WHY ONE ARRAY IS ENOUGH. Every payoff here reads relative performance
 * `path[i] / path[0]`, and a worst-of payoff is a function of
 * `min_j S_j(t)/S_j(0)` alone. A knock-in watches the lowest the worst leg
 * ever went, and the lowest over time of the worst over legs is the lowest
 * over both. Redemption and autocall triggers read the worst leg on their own
 * dates. None of them asks WHICH leg is worst, only how far down it is. So
 * collapsing to one number per step loses nothing, and every evaluator, the
 * observables cache and the slice pooling keep working untouched.
 *
 * `drift` and `diffCoeff` are STEP-MAJOR, `nSteps * nAssets` entries, so leg
 * `j` of step `i` is at `i * nAssets + j`. `z` uses the same layout, which
 * makes the inner correlation loop read contiguous memory. `chol` is the
 * lower-triangular Cholesky factor of the correlation matrix, row-major, so
 * `chol[j * nAssets + k]` multiplies the independent normal `k`.
 *
 * NOT BIT-IDENTICAL TO `fillPath` AT ONE ASSET, deliberately. This routine
 * accumulates each leg's LOG performance and exponentiates once per step,
 * whereas `fillPath` multiplies the running level by an exponential each step.
 * The two differ in the last bits, so a single-asset product must keep using
 * `fillPath`. `PathBatchGenerator` guards on `nAssets >= 2` for exactly that
 * reason.
 *
 * `logPerf` is caller-owned scratch of length nAssets, reused across paths.
 */
export function fillBasketPath(
  out: Float64Array,
  s0: number,
  drift: Float64Array,
  diffCoeff: Float64Array,
  chol: Float64Array,
  z: Float64Array,
  nAssets: number,
  logPerf: Float64Array,
  sign: 1 | -1,
): void {
  out[0] = s0;
  const nSteps = out.length - 1;
  logPerf.fill(0);
  for (let i = 0; i < nSteps; i++) {
    const base = i * nAssets;
    let worst = Infinity;
    for (let j = 0; j < nAssets; j++) {
      // Correlate: row j of the Cholesky factor against this step's normals.
      // The factor is lower triangular, so only k <= j contribute.
      let w = 0;
      const crow = j * nAssets;
      for (let k = 0; k <= j; k++) w += chol[crow + k] * z[base + k];
      logPerf[j] += drift[base + j] + diffCoeff[base + j] * sign * w;
      const p = Math.exp(logPerf[j]);
      if (p < worst) worst = p;
    }
    out[i + 1] = s0 * worst;
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
  /** Basket leg count. 1 means a single underlying and the scalar code path. */
  private readonly basketN: number;
  /** Lower-triangular Cholesky factor, row-major. Basket only. */
  private readonly chol?: Float64Array;
  /** Reused per-leg log-performance scratch. Basket only. */
  private readonly logPerf?: Float64Array;

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
    // A basket draws one normal per leg per step, so the live buffer and the
    // pre-drawn slice are both nSteps * nAssets long. At one leg that is
    // nSteps, exactly as before, which is what keeps the scalar path untouched.
    const nAssets = market.basket && market.basket.assets.length >= 2 ? market.basket.assets.length : 1;
    if (zSlice) {
      this.zSlice = zSlice;
      this.z = new Float64Array(0);
    } else {
      this.z = new Float64Array(nSteps * nAssets);
      this.nextNormal = normals(seed);
    }

    const { vol, volPerStep, rateCurve, divYield } = market;
    const borrow = (market.costs?.borrowCostBp ?? 0) / 10_000;

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

    // A basket of two or more legs takes its own branch. One leg is NOT routed
    // here: `fillBasketPath` accumulates log performance where `fillPath`
    // multiplies levels, and the two differ in the last bits, so a single
    // underlying keeps the exact code it has always used.
    if (market.basket && nAssets >= 2) {
      const b = buildBasketCoefficients(market, nAssets, nSteps, stepDt, stepStartTimes);
      this.basketN = nAssets;
      this.chol = b.chol;
      this.logPerf = new Float64Array(nAssets);
      this.drift = b.drift;
      this.diffCoeff = b.diffCoeff;
      return;
    }
    this.basketN = 1;
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
    if (this.basketN >= 2) {
      const { chol, logPerf, basketN } = this;
      fillBasketPath(this.plusBuf, this.s0, this.drift, this.diffCoeff, chol!, z, basketN, logPerf!, 1);
      fillBasketPath(this.minusBuf, this.s0, this.drift, this.diffCoeff, chol!, z, basketN, logPerf!, -1);
      return { plus: this.plusBuf, minus: this.minusBuf };
    }
    fillPath(this.plusBuf, this.s0, this.drift, this.diffCoeff, z, 1);
    fillPath(this.minusBuf, this.s0, this.drift, this.diffCoeff, z, -1);
    return { plus: this.plusBuf, minus: this.minusBuf };
  }

  /** Draws a single (non-antithetic) path, reusing the `plus` buffer. */
  nextSingle(): Float64Array {
    const z = this.zSlice ? this.zSlice.singles![this.zIdx++] : this.liveZ();
    if (this.basketN >= 2) {
      fillBasketPath(this.plusBuf, this.s0, this.drift, this.diffCoeff, this.chol!, z, this.basketN, this.logPerf!, 1);
      return this.plusBuf;
    }
    fillPath(this.plusBuf, this.s0, this.drift, this.diffCoeff, z, 1);
    return this.plusBuf;
  }

  /** Draws nSteps fresh normals into the reusable `z` buffer. Live mode
   * only — see constructor. */
  private liveZ(): Float64Array {
    // `this.z` is nSteps * basketN long, so this fills the whole buffer either
    // way and the draw order stays step-major with the legs innermost.
    for (let i = 0; i < this.z.length; i++) this.z[i] = this.nextNormal!();
    return this.z;
  }
}

/**
 * Per-leg drift and diffusion coefficients for a basket, plus the Cholesky
 * factor of its correlation matrix. Computed ONCE per generator, never per
 * path, exactly like the scalar branch's arrays.
 *
 * Both arrays are STEP-MAJOR: leg `j` of step `i` sits at `i * nAssets + j`.
 *
 * Each leg drifts at `rate - divYield_j - borrow`, with its own dividend, and
 * carries its own Ito correction `-0.5 * vol_j^2`, so the log-Euler step is
 * exact for the piecewise-constant model. A rate curve substitutes that step's
 * instantaneous forward rate for the flat `rate`, the same substitution the
 * scalar branch makes.
 *
 * Two combinations THROW rather than pricing something quietly wrong:
 *
 *  - Basket plus quanto. The quanto correction is `-rho_j * vol_j * fxVol` and
 *    needs one correlation PER LEG against the exchange rate. `QuantoParams`
 *    carries a single `corrEqFx`, which is the single-underlying case, so
 *    there is no honest value to use for the other legs.
 *  - Basket plus a per-step vol schedule. `volPerStep` is built from ONE
 *    surface at ONE risk strike (see worker/pricing.ts's `effectiveMarketFor`)
 *    and a basket needs a schedule per leg. A flat per-leg vol is the v1
 *    scope, so a schedule reaching here means the caller built it wrongly.
 */
function buildBasketCoefficients(
  market: MarketData,
  nAssets: number,
  nSteps: number,
  stepDt: number | Float64Array | number[],
  stepStartTimes: Float64Array,
): { drift: Float64Array; diffCoeff: Float64Array; chol: Float64Array } {
  const basket = market.basket!;
  if (market.quanto) {
    throw new Error('A worst-of basket cannot be quanto: the drift needs one equity-FX correlation per leg');
  }
  if (market.volPerStep) {
    throw new Error('A worst-of basket cannot carry a per-step vol schedule: it is built for one underlying');
  }
  if (basket.assets.length !== nAssets) {
    throw new Error(`basket has ${basket.assets.length} legs for ${nAssets} expected`);
  }
  if (basket.correlation.length !== nAssets) {
    throw new Error(`correlation matrix is ${basket.correlation.length}x? for ${nAssets} legs`);
  }

  const borrow = (market.costs?.borrowCostBp ?? 0) / 10_000;
  const rateCurve = market.rateCurve;
  const useCurve = !!rateCurve && rateCurve.length > 0;

  const drift = new Float64Array(nSteps * nAssets);
  const diffCoeff = new Float64Array(nSteps * nAssets);
  const dtOf = (i: number): number => (typeof stepDt === 'number' ? stepDt : stepDt[i]);

  for (let i = 0; i < nSteps; i++) {
    const dt = dtOf(i);
    const sqrtDt = Math.sqrt(dt);
    let rate = market.rate;
    if (useCurve) {
      const t1 = stepStartTimes[i];
      const t2 = t1 + dt;
      rate = (rateAt(rateCurve!, t2) * t2 - rateAt(rateCurve!, t1) * t1) / dt;
    }
    const base = i * nAssets;
    for (let j = 0; j < nAssets; j++) {
      const leg = basket.assets[j];
      const v = leg.vol;
      drift[base + j] = (rate - leg.divYield - borrow - 0.5 * v * v) * dt;
      diffCoeff[base + j] = v * sqrtDt;
    }
  }

  // Flatten the Cholesky factor row-major, so the inner loop reads one
  // contiguous run per leg.
  const L = choleskyLower(basket.correlation);
  const chol = new Float64Array(nAssets * nAssets);
  for (let j = 0; j < nAssets; j++) {
    for (let k = 0; k <= j; k++) chol[j * nAssets + k] = L[j][k];
  }
  return { drift, diffCoeff, chol };
}
