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

export function buildGrid(spec: ProductSpec): PricingGrid {
  const nSteps = Math.max(1, Math.round(spec.tenorYears * STEPS_PER_YEAR));
  const dtYears = spec.tenorYears / nSteps;

  let couponObs: number[] = [];
  let callObs: number[] = [];
  let settlementObs: number[] = [];

  if (spec.kind === 'coupon') {
    couponObs = periodicObs(
      spec.tenorYears,
      PERIODS_PER_YEAR[spec.couponFrequency],
      nSteps,
      dtYears,
    );
    if (spec.callType !== 'none') {
      callObs = periodicObs(spec.tenorYears, PERIODS_PER_YEAR[spec.callFrequency], nSteps, dtYears);
    }
  } else if (spec.kind === 'participation') {
    couponObs = [nSteps];
  } else if (spec.kind === 'accumulator') {
    const stepInterval = spec.settlementFrequency === 'weekly' ? 5 : 21;
    settlementObs = settlementSchedule(nSteps, stepInterval);
  }

  return {
    nSteps,
    dtYears,
    tenorYears: spec.tenorYears,
    couponObs,
    callObs,
    settlementObs,
  };
}
