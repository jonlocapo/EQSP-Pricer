import type { AccumulatorSpec } from '../../model/product';
import type { EvaluatorContext, PathOutcome, PayoffEvaluator, PricingGrid } from './types';
import { timeOf } from './types';

/** 1-based settlement period containing `day` (day is a grid index, 1..nSteps). */
function periodOfDay(day: number, settlementObs: number[]): number {
  for (let p = 0; p < settlementObs.length; p++) {
    if (day <= settlementObs[p]) return p + 1;
  }
  return settlementObs.length;
}

export function makeAccumulatorEvaluator(
  spec: AccumulatorSpec,
  ctx: EvaluatorContext,
): PayoffEvaluator {
  const grid: PricingGrid = ctx.grid;
  const nSteps = grid.nSteps;
  const settlementObs = grid.settlementObs;
  const estimatedNotional = spec.dailyShares * nSteps * (spec.strikePct / 100) * ctx.market.spot;
  // sign = +1 accumulate (buy cheap), -1 decumulate (sell rich). All three
  // direction-dependent comparisons reduce to this single constant:
  //   KO:      sign * (S - trigger) >= 0   (accumulate: S >= trigger; decumulate: S <= trigger)
  //   geared:  sign * (S - strike)  <  0   (accumulate: S < strike;  decumulate: S > strike)
  //   cashflow: shares * sign * (S_settle - strike)  (accumulate: S_settle - strike; decumulate: strike - S_settle)
  const sign = spec.direction === 'decumulate' ? -1 : 1;

  return (spots: Float64Array): PathOutcome => {
    const S0 = spots[0];
    const strike = (spec.strikePct / 100) * S0;
    const trigger = (spec.koTriggerPct / 100) * S0;

    let koIdx = Infinity;
    for (let i = 1; i <= nSteps; i++) {
      if (sign * (spots[i] - trigger) >= 0) {
        koIdx = i;
        break;
      }
    }

    let cutoff = Infinity;
    if (koIdx <= nSteps) {
      if (spec.koSettlement === 'ko0') {
        cutoff = koIdx;
      } else if (spec.koSettlement === 'ko1') {
        cutoff = koIdx + 1;
      } else {
        // periodEnd: accumulate through the entire period containing koIdx.
        const p = periodOfDay(koIdx, settlementObs);
        cutoff = settlementObs[p - 1] + 1;
      }
    }

    let pv = 0;
    let lastAccumulatingDay = 0;
    let periodStart = 1;

    for (let p = 1; p <= settlementObs.length; p++) {
      const periodEndIdx = settlementObs[p - 1];
      let accumulatedShares = 0;
      for (let i = periodStart; i <= periodEndIdx; i++) {
        const accumulates = p <= spec.guaranteePeriods || i < cutoff;
        if (accumulates) {
          const geared = sign * (spots[i] - strike) < 0;
          const shares = spec.dailyShares * (geared ? spec.gearing : 1);
          accumulatedShares += shares;
          lastAccumulatingDay = i;
        }
      }
      if (accumulatedShares > 0) {
        const cashflow = accumulatedShares * sign * (spots[periodEndIdx] - strike);
        pv += ctx.df(timeOf(periodEndIdx, grid)) * cashflow;
      }
      periodStart = periodEndIdx + 1;
    }

    const pvPct = (100 * pv) / estimatedNotional;
    const koEvent = koIdx <= nSteps;
    const lastSettledIndex =
      lastAccumulatingDay > 0
        ? settlementObs[periodOfDay(lastAccumulatingDay, settlementObs) - 1]
        : settlementObs[0];

    return {
      pvPct,
      koEvent,
      lifeYears: timeOf(lastSettledIndex, grid),
    };
  };
}
