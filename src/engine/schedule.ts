import { PERIODS_PER_YEAR } from '../model/product';
import type { ProductSpec } from '../model/product';
import type { PricingGrid } from './payoffs/types';
import { STEPS_PER_YEAR } from './gbm';

/**
 * Builds ascending, deduplicated grid indices for a periodic schedule with
 * `periodsPerYear` observations per year over `tenorYears`, mapped onto a
 * grid with `nSteps` steps of `dtYears` each. Always ends at nSteps.
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
 * Same construction as `periodicObs`, but in continuous time rather than
 * snapped to a daily grid index: the real observation dates (years) for a
 * periodic schedule, ascending, deduplicated, with the last entry always
 * forced to exactly `tenorYears`. Used to build a COMPACT grid's step set —
 * for European-only monitoring, stepping the GBM straight between these
 * dates is mathematically exact (log-increments over a longer dt are still
 * exactly lognormal), so there is no need to snap to a daily grid at all.
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
 * Decides whether a spec's payoff must walk every daily step (running
 * min/max monitoring, or a per-step strike-dependent walk) or can be priced
 * exactly on a compact grid of just the dates it actually observes.
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
 * * issuerCallable only needs its own call-observation dates in principle
 *   (LSMC regression doesn't read a running extremum), but the regression
 *   here is built and tested against the daily grid; moving it to a compact
 *   grid was judged an unnecessary risk for this change (see report) — so
 *   it stays daily, marked `yes` above.
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
      // Every step feeds three strike-dependent loops (accrual, gearing,
      // KO/cutoff detection) — inherently a daily walk.
      return true;
  }
}

/**
 * Daily grid: nSteps = round(tenorYears*252), uniform dtYears.
 * `times[i] = i*dtYears` (a plain loop, NOT a cumulative sum of stepDt) and
 * `stepDt` is filled with the identical `dtYears` scalar throughout — see
 * PricingGrid's bit-identity note. This exactly reproduces the pre-adaptive-
 * grid engine's discount factors for American/accumulator/LSMC products.
 */
function buildDailyTimes(nSteps: number, dtYears: number): { times: number[]; stepDt: Float64Array } {
  const times = new Array<number>(nSteps + 1);
  for (let i = 0; i <= nSteps; i++) times[i] = i * dtYears;
  const stepDt = new Float64Array(nSteps).fill(dtYears);
  return { times, stepDt };
}

/**
 * Compact grid: step set = the sorted, deduplicated union of `obsTimes` plus
 * maturity. `stepDt[i] = times[i+1] - times[i]` (a real, possibly
 * non-uniform difference — unlike the daily grid's identical-scalar fill,
 * since these are genuinely different-length steps, e.g. a merged
 * quarterly-coupon + monthly-call schedule or a stub final period).
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
  // Guard degenerate cases: at least 1 step even if every observation date
  // collapsed onto t=0 (shouldn't happen for tenorYears > 0, but stay safe).
  const distinct = positive.length > 0 ? positive : [tenorYears];
  const times = [0, ...distinct];
  const nSteps = times.length - 1;
  // Force the final grid point to be exactly tenorYears (guards float drift
  // from the union/sort above, and matches the daily grid's guarantee).
  times[nSteps] = tenorYears;

  const stepDt = new Float64Array(nSteps);
  for (let i = 0; i < nSteps; i++) stepDt[i] = times[i + 1] - times[i];
  const dtYears = tenorYears / nSteps; // representative only — non-uniform grids have no single true dt.
  return { nSteps, times, stepDt, dtYears };
}

/**
 * Builds the DAILY grid (252/yr) for `spec`, unconditionally — i.e. the grid
 * `buildGrid` always returned before the adaptive-grid change. Used
 * internally whenever `needsDailyPath` says so, and exported for tests that
 * need an explicit daily-grid reference to compare a compact grid's price
 * against (see tests/adaptiveGrid.test.ts) — GBM stepped daily vs. stepped
 * straight to the same European observation dates are two different-but-
 * equally-valid sets of simulated paths for the identical model, so their
 * MC prices should agree to within Monte Carlo error, not bit-for-bit.
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
  // observes. Mathematically exact for European-only monitoring, not an
  // approximation — see needsDailyPath's doc comment.
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

  // Participation (European-only monitoring): only ever observes at
  // maturity — the compact grid is a single step, [0, tenorYears].
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
