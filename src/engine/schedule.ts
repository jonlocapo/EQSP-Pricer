import { PERIODS_PER_YEAR } from '../model/product';
import type { ProductSpec } from '../model/product';
import type { PricingGrid } from './payoffs/types';
import { STEPS_PER_YEAR } from './gbm';

/**
 * Builds ascending, deduplicated grid indices for a periodic schedule. The
 * schedule has `periodsPerYear` observations per year over `tenorYears`,
 * mapped onto a grid with `nSteps` steps of `dtYears` each. The result
 * always ends at nSteps.
 */
function periodicObs(
  tenorYears: number,
  periodsPerYear: number,
  nSteps: number,
  dtYears: number,
): number[] {
  const numObs = Math.round(tenorYears * periodsPerYear);
  const indices: number[] = [];
  for (let k = 1; k <= numObs; k++) {
    const t = k / periodsPerYear;
    const idx = Math.min(nSteps, Math.max(1, Math.round(t / dtYears)));
    indices.push(idx);
  }
  const deduped = Array.from(new Set(indices)).sort((a, b) => a - b);
  if (deduped.length === 0 || deduped[deduped.length - 1] !== nSteps) {
    deduped.push(nSteps);
  }
  return deduped;
}

/**
 * Same construction as `periodicObs`, but in continuous time, not snapped to
 * a daily grid index. Returns the real observation dates (years) for a
 * periodic schedule, ascending and deduplicated, with the last entry always
 * forced to exactly `tenorYears`. Used to build a COMPACT grid's step set.
 * For European-only monitoring, stepping the GBM straight between these
 * dates is mathematically exact — log-increments over a longer dt are still
 * exactly lognormal. So the grid does not need to snap to daily steps at all.
 */
function periodicTimes(tenorYears: number, periodsPerYear: number): number[] {
  const numObs = Math.round(tenorYears * periodsPerYear);
  const raw: number[] = [];
  for (let k = 1; k <= numObs; k++) raw.push(k / periodsPerYear);
  const deduped = Array.from(new Set(raw)).sort((a, b) => a - b);
  if (deduped.length === 0 || deduped[deduped.length - 1] !== tenorYears) {
    deduped.push(tenorYears);
  }
  return deduped;
}

/** Grid indices of settlement-period ends for the accumulator, every
 * `stepInterval` steps, with the last entry always forced to nSteps. */
function settlementSchedule(nSteps: number, stepInterval: number): number[] {
  const indices: number[] = [];
  for (let idx = stepInterval; idx < nSteps; idx += stepInterval) {
    indices.push(idx);
  }
  indices.push(nSteps);
  return indices;
}

/**
 * Decides whether a spec's payoff must walk every daily step, or can be
 * priced exactly on a compact grid of just the dates it actually observes. A
 * payoff needs daily steps when it has running min/max monitoring, or a walk
 * where each step depends on the strike.
 *
 *   | family / mode                                    | daily? |
 *   |---------------------------------------------------|--------|
 *   | coupon, barrierType 'none'/'european' (default)   | no     |
 *   | coupon, barrierType 'american'                    | yes    |
 *   | coupon, callType 'issuerCallable' (LSMC)           | yes*   |
 *   | participation, KI 'none'/'european', KO 'none' or  | no     |
 *   |   koRebate with 'european' koMonitoring            |        |
 *   | participation, KI 'american', or koRebate with     | yes    |
 *   |   'american' koMonitoring                          |        |
 *   | accumulator                                        | yes    |
 *
 * * In principle, issuerCallable needs only its own call-observation dates,
 *   because the LSMC regression does not read a running extremum. But the
 *   regression here is built and tested against the daily grid. Moving it to
 *   a compact grid was judged an unnecessary risk for this change (see
 *   report). So it stays daily, marked `yes` above.
 */
function needsDailyPath(spec: ProductSpec): boolean {
  switch (spec.kind) {
    case 'coupon':
      return spec.barrierType === 'american' || spec.callType === 'issuerCallable';
    case 'participation': {
      const downsideAmerican = spec.downside.barrierType === 'american';
      const koAmerican =
        spec.upside.variant.variant === 'koRebate' && spec.upside.variant.koMonitoring === 'american';
      return downsideAmerican || koAmerican;
    }
    case 'accumulator':
      // Every step feeds three strike-dependent loops: accrual, gearing, and
      // KO/cutoff detection. This is inherently a daily walk.
      return true;
  }
}

/**
 * Daily grid: nSteps = round(tenorYears*252), uniform dtYears.
 * `times[i] = i*dtYears` uses a plain loop, NOT a cumulative sum of stepDt.
 * `stepDt` is filled with the identical `dtYears` scalar throughout. See
 * PricingGrid's bit-identity note. This exactly reproduces the
 * pre-adaptive-grid engine's discount factors for American, accumulator, and
 * LSMC products.
 */
function buildDailyTimes(nSteps: number, dtYears: number): { times: number[]; stepDt: Float64Array } {
  const times = new Array<number>(nSteps + 1);
  for (let i = 0; i <= nSteps; i++) times[i] = i * dtYears;
  const stepDt = new Float64Array(nSteps).fill(dtYears);
  return { times, stepDt };
}

/**
 * Compact grid: step set = the sorted, deduplicated union of `obsTimes` plus
 * maturity. `stepDt[i] = times[i+1] - times[i]` is a real, possibly
 * non-uniform difference. This differs from the daily grid's
 * identical-scalar fill, because these steps genuinely have different
 * lengths, for example a merged quarterly-coupon and monthly-call schedule,
 * or a stub final period.
 */
function buildCompactGrid(
  obsTimes: number[],
  tenorYears: number,
): { nSteps: number; times: number[]; stepDt: Float64Array; dtYears: number } {
  const set = new Set<number>(obsTimes);
  set.add(tenorYears);
  const positive = Array.from(set)
    .filter((t) => t > 0)
    .sort((a, b) => a - b);
  // Guard against a degenerate case: keep at least 1 step, even if every
  // observation date collapsed onto t=0. This should not happen for
  // tenorYears > 0, but stay safe.
  const distinct = positive.length > 0 ? positive : [tenorYears];
  const times = [0, ...distinct];
  const nSteps = times.length - 1;
  // Force the final grid point to be exactly tenorYears. This guards against
  // float drift from the union/sort above, and matches the daily grid's
  // guarantee.
  times[nSteps] = tenorYears;

  const stepDt = new Float64Array(nSteps);
  for (let i = 0; i < nSteps; i++) stepDt[i] = times[i + 1] - times[i];
  const dtYears = tenorYears / nSteps; // representative only — a non-uniform grid has no single true dt.
  return { nSteps, times, stepDt, dtYears };
}

/**
 * Builds the DAILY grid (252/yr) for `spec`, unconditionally. This is the
 * grid `buildGrid` always returned before the adaptive-grid change. Used
 * internally whenever `needsDailyPath` requires it, and exported for tests
 * that need an explicit daily-grid reference to compare a compact grid's
 * price against (see tests/adaptiveGrid.test.ts). A GBM path stepped daily,
 * and a GBM path stepped straight to the same European observation dates,
 * are two different but equally valid sets of simulated paths for the
 * identical model. So their MC prices should agree to within Monte Carlo
 * error, not bit-for-bit.
 */
export function buildDailyGrid(spec: ProductSpec): PricingGrid {
  const nSteps = Math.max(1, Math.round(spec.tenorYears * STEPS_PER_YEAR));
  const dtYears = spec.tenorYears / nSteps;
  const { times, stepDt } = buildDailyTimes(nSteps, dtYears);

  let couponObs: number[] = [];
  let callObs: number[] = [];
  let settlementObs: number[] = [];

  if (spec.kind === 'coupon') {
    couponObs = periodicObs(spec.tenorYears, PERIODS_PER_YEAR[spec.couponFrequency], nSteps, dtYears);
    if (spec.callType !== 'none') {
      callObs = periodicObs(spec.tenorYears, PERIODS_PER_YEAR[spec.callFrequency], nSteps, dtYears);
    }
  } else if (spec.kind === 'participation') {
    couponObs = [nSteps];
  } else if (spec.kind === 'accumulator') {
    const stepInterval =
      spec.settlementFrequency === 'weekly' ? 5 : spec.settlementFrequency === 'biweekly' ? 10 : 21;
    settlementObs = settlementSchedule(nSteps, stepInterval);
  }

  return { nSteps, dtYears, tenorYears: spec.tenorYears, times, stepDt, couponObs, callObs, settlementObs };
}

export function buildGrid(spec: ProductSpec): PricingGrid {
  if (needsDailyPath(spec)) {
    return buildDailyGrid(spec);
  }

  // Compact grid: step set = sorted union of the dates this payoff actually
  // observes. This is mathematically exact for European-only monitoring, not
  // an approximation. See needsDailyPath's doc comment.
  if (spec.kind === 'coupon') {
    const couponTimes = periodicTimes(spec.tenorYears, PERIODS_PER_YEAR[spec.couponFrequency]);
    const callTimes =
      spec.callType !== 'none' ? periodicTimes(spec.tenorYears, PERIODS_PER_YEAR[spec.callFrequency]) : [];
    const { nSteps, times, stepDt, dtYears } = buildCompactGrid([...couponTimes, ...callTimes], spec.tenorYears);
    const indexOf = new Map<number, number>();
    times.forEach((t, i) => indexOf.set(t, i));
    const couponObs = couponTimes.map((t) => indexOf.get(t)!);
    const callObs = callTimes.map((t) => indexOf.get(t)!);
    return { nSteps, dtYears, tenorYears: spec.tenorYears, times, stepDt, couponObs, callObs, settlementObs: [] };
  }

  // Participation (European-only monitoring) only ever observes at
  // maturity. So the compact grid is a single step: [0, tenorYears].
  const { nSteps, times, stepDt, dtYears } = buildCompactGrid([], spec.tenorYears);
  return {
    nSteps,
    dtYears,
    tenorYears: spec.tenorYears,
    times,
    stepDt,
    couponObs: [nSteps],
    callObs: [],
    settlementObs: [],
  };
}
