/**
 * GARCH(1,1) variance forecasting, the mean-reverting replacement for the
 * four overlapping trailing windows in `./realizedSurface.ts`'s
 * `realizedTermStructure`.
 *
 * WHY: a trailing window (21, 63, 126 or 252 days) is a LAGGING average —
 * it reports what variance WAS over that window, not what it is expected to
 * BE over the option's life, and the four windows overlap so heavily that
 * their "term structure" is mostly an artefact of window length, not a real
 * forward view. Real variance mean-reverts: after a shock it decays back
 * toward a long-run level, which is exactly why a 1-month option and a
 * 5-year option should NOT be priced off the same lagging average.
 * GARCH(1,1) is the standard, simplest model that captures this:
 *
 *   sigma2_t = omega + alpha * r_{t-1}^2 + beta * sigma2_{t-1}
 *
 * `alpha` is how much yesterday's shock feeds into today's variance,
 * `beta` is how much of yesterday's variance persists, and stationarity
 * needs `alpha + beta < 1` — the model reverts to a long-run variance
 * `omega / (1 - alpha - beta)` whenever `alpha + beta < 1`.
 *
 * CALIBRATION: maximum likelihood under a Gaussian likelihood, with
 * VARIANCE TARGETING to cut the problem from three parameters to two. A
 * free three-parameter fit is a well-known headache on a few hundred daily
 * observations — the likelihood surface is flat along ridges and omega in
 * particular is poorly identified on its own. Variance targeting fixes
 * `omega = sampleVar * (1 - alpha - beta)`, so the model's long-run
 * variance is pinned to the SAMPLE variance by construction, and only
 * `(alpha, beta)` are optimized. This is standard practice (see Engle and
 * Mezrich 1996) and is far more stable in a small sample.
 *
 * TERM STRUCTURE: the real deliverable. Under GARCH(1,1), the h-step-ahead
 * expected variance is
 *
 *   E[sigma2_{t+h}] = sigma2_bar + (alpha+beta)^(h-1) * (sigma2_{t+1} - sigma2_bar)
 *
 * with `sigma2_bar` the long-run variance and `sigma2_{t+1}` tomorrow's
 * one-step forecast. An option over the next T days prices on the expected
 * AVERAGE variance over those T days, not the variance on day T alone, so
 * this file sums that geometric series in CLOSED FORM (see
 * `garchTermStructure` below) rather than simulating any paths.
 *
 * FALLBACK: when the fit does not converge, or lands on or past the
 * stationarity boundary, or the sample is too short to trust a two-
 * parameter fit, this file falls back to EWMA (RiskMetrics, lambda 0.94).
 * EWMA is the DEGENERATE GARCH case `alpha + beta = 1` (no mean reversion
 * at all), so its term structure is flat — which is the honest answer when
 * the sample gives no real evidence of mean reversion.
 */
import { nelderMead } from './optimize';

/** Trading days per year, matching the engine's simulation frequency and
 * `realizedSurface.ts`'s DAYS_PER_YEAR. */
const DAYS_PER_YEAR = 252;

/** RiskMetrics' standard EWMA decay for daily equity returns. */
export const EWMA_LAMBDA = 0.94;

/**
 * Daily variance persistence used ONLY when the GARCH fit does not converge and
 * an unconditional anchor is available. 0.97 is a typical equity figure, giving
 * a half-life near 23 days, so a shock has largely decayed within a quarter.
 *
 * It is a default, not a measurement. It exists because assuming variance never
 * reverts is a stronger and worse claim than assuming it reverts at roughly the
 * usual speed.
 */
export const FALLBACK_PERSISTENCE = 0.97;

export interface Garch11Params {
  omega: number;
  alpha: number;
  beta: number;
}

export interface Garch11Fit extends Garch11Params {
  /** Conditional variance path: sigma2[t] is the variance forecast that was
   * in force ENTERING day t, i.e. before day t's return updates it. */
  sigma2: number[];
  /** One-step-ahead forecast for the day after the sample ends —
   * `sigma2_{T+1}` in the module comment's term-structure formula. */
  nextVar: number;
  /** Gaussian log-likelihood at the fitted parameters. NaN when the fit did
   * not converge, since the "fit" is then a placeholder, not a real MLE. */
  logLik: number;
  converged: boolean;
}

/** Gaussian log-likelihood of a GARCH(1,1) path, plus the variance path
 * itself. Seeds the recursion with the sample's own second moment of
 * returns (mean(r^2)) — the standard, simple choice absent a better prior
 * for the very first day's variance. */
function evaluate(returns: number[], omega: number, alpha: number, beta: number): { negLogLik: number; sigma2: number[] } {
  const n = returns.length;
  const sigma2: number[] = new Array(n);
  let variance = returns.reduce((a, r) => a + r * r, 0) / n;
  let negLogLik = 0;
  for (let t = 0; t < n; t++) {
    sigma2[t] = variance;
    const r = returns[t];
    if (!(variance > 0)) {
      negLogLik = Number.POSITIVE_INFINITY;
      break;
    }
    negLogLik += 0.5 * (Math.log(2 * Math.PI) + Math.log(variance) + (r * r) / variance);
    variance = omega + alpha * r * r + beta * variance;
  }
  return { negLogLik, sigma2 };
}

/** How close `alpha + beta` may sit to the 1.0 stationarity boundary before
 * the fit is rejected as "did not really find mean reversion" and the
 * caller falls back to EWMA. */
const MAX_PERSISTENCE = 1 - 1e-4;
/** Below this many return observations, a free two-parameter MLE fit is not
 * trustworthy — GARCH needs enough shocks to separate the ARCH and GARCH
 * effects from noise. EWMA needs no such minimum, so this is the honest
 * threshold to fall back at. */
const MIN_OBS_FOR_FIT = 80;

function degenerateFit(returns: number[]): Garch11Fit {
  const sampleVar = returns.length > 0 ? returns.reduce((a, r) => a + r * r, 0) / returns.length : 0;
  return {
    omega: 0,
    alpha: 0,
    // beta = 1 signals "no mean reversion", the EWMA degenerate case, so any
    // caller that reads params directly (rather than checking `converged`)
    // still gets a sane, unit-persistence read rather than an arbitrary one.
    beta: 1,
    sigma2: new Array(returns.length).fill(sampleVar),
    nextVar: sampleVar,
    logLik: NaN,
    converged: false,
  };
}

/**
 * Fits GARCH(1,1) to a daily log-return series by maximum likelihood, using
 * variance targeting to reduce the free parameters to `(alpha, beta)`.
 *
 * `targetVar`, if given, replaces the sample variance of `returns` as the
 * variance-targeting anchor — the caller can pass a more EFFICIENT range-
 * based daily variance estimate here (see `./volEstimators.ts`'s
 * `yangZhangVar`), so the long-run level GARCH reverts to is not itself
 * built on the noisy close-to-close estimator this whole module exists to
 * move past.
 *
 * Returns a `degenerateFit` (unconverged, `beta = 1`) when the sample is
 * too short, the target variance is not usable, or the optimizer's best
 * point violates stationarity or sits on its boundary. The caller (see
 * `garchTermStructure`) treats that as "fall back to EWMA".
 */
export function fitGarch11(returns: number[], targetVar?: number): Garch11Fit {
  const n = returns.length;
  const sampleVar = targetVar ?? (n > 0 ? returns.reduce((a, r) => a + r * r, 0) / n : 0);
  if (n < MIN_OBS_FOR_FIT || !(sampleVar > 0)) {
    return degenerateFit(returns);
  }

  // Parameterize (alpha, beta) through an unconstrained (p, q) so the
  // optimizer can never leave the stationary region alpha>0, beta>0,
  // alpha+beta<1, and no post-hoc rejection-and-retry logic is needed:
  //   alpha = ALPHA_CAP * sigmoid(p)         in (0, ALPHA_CAP)
  //   beta  = (1 - alpha) * sigmoid(q)       in (0, 1 - alpha)
  // ALPHA_CAP keeps the ARCH weight within the range real daily-equity
  // fits occupy; nothing stops the optimizer from picking alpha near 0.
  const ALPHA_CAP = 0.3;
  const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
  const logit = (p: number) => Math.log(p / (1 - p));
  const toAlphaBeta = (p: number[]): [number, number] => {
    const alpha = ALPHA_CAP * sigmoid(p[0]);
    const beta = (1 - alpha) * sigmoid(p[1]);
    return [alpha, beta];
  };

  const objective = (p: number[]): number => {
    const [alpha, beta] = toAlphaBeta(p);
    const omega = sampleVar * (1 - alpha - beta);
    if (!(omega > 0)) return Number.POSITIVE_INFINITY;
    const { negLogLik } = evaluate(returns, omega, alpha, beta);
    return Number.isFinite(negLogLik) ? negLogLik : Number.POSITIVE_INFINITY;
  };

  // Start near a typical daily-equity fit (alpha ~ 0.08, beta ~ 0.90): a
  // reasonable prior that also keeps the initial simplex inside the region
  // where the likelihood is well-defined.
  const x0 = [logit(0.08 / ALPHA_CAP), logit(0.9 / (1 - 0.08))];
  const result = nelderMead(objective, x0, { maxIter: 400, initialStep: 0.5 });
  const [alpha, beta] = toAlphaBeta(result.x);
  const persistence = alpha + beta;
  const omega = sampleVar * (1 - persistence);

  if (
    !result.converged ||
    !(omega > 0) ||
    persistence >= MAX_PERSISTENCE ||
    alpha <= 1e-6 ||
    beta <= 1e-6 ||
    !Number.isFinite(result.fx)
  ) {
    return degenerateFit(returns);
  }

  const { negLogLik, sigma2 } = evaluate(returns, omega, alpha, beta);
  const lastReturn = returns[n - 1];
  const nextVar = omega + alpha * lastReturn * lastReturn + beta * sigma2[n - 1];
  return { omega, alpha, beta, sigma2, nextVar, logLik: -negLogLik, converged: true };
}

/**
 * EWMA (RiskMetrics) daily variance: `sigma2_t = lambda*sigma2_{t-1} +
 * (1-lambda)*r_{t-1}^2`, seeded with the first observation's own squared
 * return. This is the GARCH(1,1) degenerate case `omega = 0, alpha =
 * 1-lambda, beta = lambda` (so `alpha + beta = 1` exactly): no mean
 * reversion, which is why its term structure is flat.
 */
export function ewmaVariance(returns: number[], lambda: number = EWMA_LAMBDA): number {
  if (returns.length === 0) return 0;
  let variance = returns[0] * returns[0];
  for (let i = 1; i < returns.length; i++) {
    variance = lambda * variance + (1 - lambda) * returns[i] * returns[i];
  }
  return variance;
}

export interface GarchTermPoint {
  tYears: number;
  vol: number;
}

export interface GarchTermStructureResult {
  /** Ascending by tYears, one point per entry in `horizonsDays`. */
  terms: GarchTermPoint[];
  /** False whenever the GARCH fit was rejected and the terms come from the
   * flat EWMA fallback instead. */
  converged: boolean;
  params?: Garch11Params;
}

/**
 * The term structure of expected AVERAGE annualized variance over each
 * horizon in `horizonsDays`, in closed form from the fitted GARCH(1,1)
 * parameters — no simulation.
 *
 * Derivation: the average expected variance over the next T days is
 *
 *   avgVar(T) = (1/T) * sum_{h=1}^{T} E[sigma2_{t+h}]
 *             = sigma2_bar + (sigma2_{t+1} - sigma2_bar) * (1/T) * sum_{h=1}^{T} p^(h-1)
 *
 * with `p = alpha + beta` the persistence and `sigma2_bar` the long-run
 * variance. The geometric sum has the closed form `(1 - p^T) / (1 - p)`,
 * which this function evaluates directly rather than looping or
 * simulating. As `p -> 1` that closed form is a removable 0/0
 * singularity — the correct limit is `T` (see the L'Hopital-style limit
 * used below), which makes `avgVar(T) -> sigma2_{t+1}` for every horizon:
 * exactly the flat EWMA case, evaluated as a limit rather than by a
 * separate code path.
 *
 * `targetVar`, if given, is passed through to `fitGarch11` as the variance-
 * targeting anchor (see its own comment for why a range-based estimator
 * belongs there).
 */
export function garchTermStructure(
  returns: number[],
  horizonsDays: number[],
  targetVar?: number,
): GarchTermStructureResult {
  const fit = fitGarch11(returns, targetVar);

  if (!fit.converged) {
    // EWMA at lambda 0.94 has a half-life near 11 days, so it is a two to three
    // week CONDITIONAL estimate. Holding it flat to every horizon extrapolates
    // a recent shock across the whole life of the trade. Measured on a defensive
    // staple that had moved sharply, that produced a 33% six-month vol against a
    // long-run level near 15%, and once the risk premium was applied the note
    // priced nowhere near a dealer quote.
    //
    // So when an unconditional anchor is available, revert toward it. Variance
    // mean-reverts whether or not this particular sample let the fit converge,
    // and refusing to model that is a stronger claim than modelling it with a
    // default speed. The shape is the SAME closed form the converged branch
    // uses, with a typical equity persistence in place of a fitted one, starting
    // from the EWMA level and decaying to the anchor.
    const shortVar = Math.max(0, ewmaVariance(returns));
    if (targetVar !== undefined && targetVar > 0) {
      const terms = horizonsDays.map((T) => {
        const factor = (1 - Math.pow(FALLBACK_PERSISTENCE, T)) / (1 - FALLBACK_PERSISTENCE) / T;
        const avgVar = targetVar + (shortVar - targetVar) * factor;
        return { tYears: T / DAYS_PER_YEAR, vol: Math.sqrt(Math.max(0, avgVar) * DAYS_PER_YEAR) };
      });
      return { terms, converged: false };
    }
    // No anchor to revert to, so flat EWMA remains the honest answer.
    const vol = Math.sqrt(shortVar * DAYS_PER_YEAR);
    return {
      terms: horizonsDays.map((d) => ({ tYears: d / DAYS_PER_YEAR, vol })),
      converged: false,
    };
  }

  const { omega, alpha, beta, nextVar } = fit;
  const persistence = alpha + beta;
  const longRunVar = omega / (1 - persistence);

  const terms = horizonsDays.map((T) => {
    let avgVar: number;
    if (Math.abs(1 - persistence) < 1e-8) {
      // Limit p -> 1: the geometric sum (1 - p^T)/(1 - p) -> T, so the
      // average collapses to tomorrow's forecast for every horizon.
      avgVar = nextVar;
    } else {
      const geometricFactor = (1 - Math.pow(persistence, T)) / (1 - persistence) / T;
      avgVar = longRunVar + (nextVar - longRunVar) * geometricFactor;
    }
    const vol = Math.sqrt(Math.max(0, avgVar) * DAYS_PER_YEAR);
    return { tYears: T / DAYS_PER_YEAR, vol };
  });

  return { terms, converged: true, params: { omega, alpha, beta } };
}
