import { PERIODS_PER_YEAR, type CouponProductSpec } from '../../model/product';
import type {
  CashflowExtractor,
  EvaluatorContext,
  PathCashflows,
  PathOutcome,
  PayoffEvaluator,
  PricingGrid,
} from './types';
import { timeOf } from './types';

/**
 * Merged observation event: a grid index carries a coupon obs and/or a call
 * obs (they may coincide, e.g. quarterly coupon + quarterly call). Precompute
 * one ascending schedule of events so the per-path walk is a single pass.
 */
interface CouponEvent {
  gridIndex: number;
  /** 1-based coupon period index, if this is a coupon observation. */
  couponPeriod?: number;
  /** 1-based call period index, if this is a call observation. */
  callPeriod?: number;
}

function mergeEvents(grid: PricingGrid): CouponEvent[] {
  const byIndex = new Map<number, CouponEvent>();
  grid.couponObs.forEach((gi, idx) => {
    const ev = byIndex.get(gi) ?? { gridIndex: gi };
    ev.couponPeriod = idx + 1;
    byIndex.set(gi, ev);
  });
  grid.callObs.forEach((gi, idx) => {
    const ev = byIndex.get(gi) ?? { gridIndex: gi };
    ev.callPeriod = idx + 1;
    byIndex.set(gi, ev);
  });
  return Array.from(byIndex.values()).sort((a, b) => a.gridIndex - b.gridIndex);
}

/** Call barrier (decimal, e.g. 1.00 = 100%) for 1-based call period j. */
function callBarrierDecimal(spec: CouponProductSpec, j: number): number {
  switch (spec.callType) {
    case 'constant':
      return spec.callBarrierPct / 100;
    case 'stepdown':
      return (spec.callBarrierPct - spec.stepDownPct * (j - spec.callFromPeriod)) / 100;
    case 'custom':
      return spec.customCallBarriersPct[j - 1] / 100;
    default:
      // 'none' / 'issuerCallable': callability is gated separately.
      return Infinity;
  }
}

function isCallable(spec: CouponProductSpec, j: number): boolean {
  return (
    j >= spec.callFromPeriod &&
    (spec.callType === 'constant' || spec.callType === 'stepdown' || spec.callType === 'custom')
  );
}

/** Autocall coupon paid on redemption (call or, in the extractor, hypothetical) at period j. */
function redemptionCostPctAt(spec: CouponProductSpec, j: number): number {
  return 100 + (spec.autocallCouponPaPct * j) / PERIODS_PER_YEAR[spec.callFrequency];
}

function couponAmountPct(spec: CouponProductSpec): number {
  return spec.couponPaPct / PERIODS_PER_YEAR[spec.couponFrequency];
}

function kiEventFor(spec: CouponProductSpec, spots: Float64Array): boolean | undefined {
  const nSteps = spots.length - 1;
  const perfT = spots[nSteps] / spots[0];
  switch (spec.barrierType) {
    case 'none':
      return undefined;
    case 'european':
      return perfT < spec.kiBarrierPct / 100;
    case 'american': {
      let minPerf = Infinity;
      for (let i = 1; i <= nSteps; i++) {
        const p = spots[i] / spots[0];
        if (p < minPerf) minPerf = p;
      }
      return minPerf < spec.kiBarrierPct / 100;
    }
  }
}

function isKnockedIn(spec: CouponProductSpec, spots: Float64Array): boolean {
  if (spec.barrierType === 'none') return true;
  return kiEventFor(spec, spots) === true;
}

function maturityRedemptionPct(spec: CouponProductSpec, spots: Float64Array): number {
  const nSteps = spots.length - 1;
  const perfT = spots[nSteps] / spots[0];
  const ki = isKnockedIn(spec, spots);
  if (!ki) return 100;
  const strike = spec.putStrikePct / 100;
  const loss = (spec.downsideLeveragePct / 100) * Math.max(0, strike - perfT) / strike;
  return 100 * Math.max(0, 1 - loss);
}

export function makeCouponEvaluator(spec: CouponProductSpec, ctx: EvaluatorContext): PayoffEvaluator {
  const { grid } = ctx;
  const events = mergeEvents(grid);
  const coupon = couponAmountPct(spec);

  return (spots: Float64Array): PathOutcome => {
    const S0 = spots[0];
    let pvPct = 0;
    let missed = 0;

    for (const ev of events) {
      const perf = spots[ev.gridIndex] / S0;

      if (ev.couponPeriod !== undefined) {
        if (spec.couponType === 'fixed') {
          pvPct += ctx.df(timeOf(ev.gridIndex, grid)) * coupon;
        } else {
          const barrier = spec.couponBarrierPct / 100;
          if (perf >= barrier) {
            if (spec.couponType === 'memory') {
              pvPct += ctx.df(timeOf(ev.gridIndex, grid)) * coupon * (1 + missed);
              missed = 0;
            } else {
              pvPct += ctx.df(timeOf(ev.gridIndex, grid)) * coupon;
            }
          } else if (spec.couponType === 'memory') {
            missed++;
          }
        }
      }

      if (ev.callPeriod !== undefined && isCallable(spec, ev.callPeriod)) {
        const barrier = callBarrierDecimal(spec, ev.callPeriod);
        if (perf >= barrier) {
          pvPct += ctx.df(timeOf(ev.gridIndex, grid)) * redemptionCostPctAt(spec, ev.callPeriod);
          return {
            pvPct,
            calledAtPeriod: ev.callPeriod,
            kiEvent: undefined,
            lifeYears: timeOf(ev.gridIndex, grid),
          };
        }
      }
    }

    const nSteps = grid.nSteps;
    const redemption = maturityRedemptionPct(spec, spots);
    pvPct += ctx.df(timeOf(nSteps, grid)) * redemption;

    return {
      pvPct,
      kiEvent: kiEventFor(spec, spots),
      lifeYears: spec.tenorYears,
    };
  };
}

export function makeCouponCashflowExtractor(
  spec: CouponProductSpec,
  ctx: EvaluatorContext,
): { extractor: CashflowExtractor; redemptionCostPct: (period: number) => number } {
  const { grid } = ctx;
  const events = mergeEvents(grid);
  const coupon = couponAmountPct(spec);

  const extractor: CashflowExtractor = (spots: Float64Array): PathCashflows => {
    const S0 = spots[0];
    const gridIndices: number[] = [];
    const amountsPct: number[] = [];
    let missed = 0;

    for (const ev of events) {
      if (ev.couponPeriod === undefined) continue;
      const perf = spots[ev.gridIndex] / S0;
      if (spec.couponType === 'fixed') {
        gridIndices.push(ev.gridIndex);
        amountsPct.push(coupon);
      } else {
        const barrier = spec.couponBarrierPct / 100;
        if (perf >= barrier) {
          if (spec.couponType === 'memory') {
            gridIndices.push(ev.gridIndex);
            amountsPct.push(coupon * (1 + missed));
            missed = 0;
          } else {
            gridIndices.push(ev.gridIndex);
            amountsPct.push(coupon);
          }
        } else if (spec.couponType === 'memory') {
          missed++;
        }
      }
    }

    const nSteps = grid.nSteps;
    const redemption = maturityRedemptionPct(spec, spots);
    gridIndices.push(nSteps);
    amountsPct.push(redemption);

    return { gridIndices, amountsPct };
  };

  return {
    extractor,
    redemptionCostPct: (period: number) => redemptionCostPctAt(spec, period),
  };
}
