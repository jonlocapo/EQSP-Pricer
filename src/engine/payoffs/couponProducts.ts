import { PERIODS_PER_YEAR, type CouponProductSpec } from '../../model/product';
import type {
  CashflowExtractor,
  EvaluatorContext,
  ObservablesEvaluator,
  ObservablesRequirements,
  OutcomeEvaluator,
  PathCashflows,
  PathObservables,
  PathOutcome,
  PayoffEvaluator,
  PricingGrid,
} from './types';
import { timeOf } from './types';

/**
 * Merged observation event: a grid index carries a coupon observation, a
 * call observation, or both. They may coincide, for example a quarterly
 * coupon and a quarterly call. Precompute one ascending schedule of events,
 * so the per-path walk is a single pass.
 */
export interface CouponEvent {
  gridIndex: number;
  /** 1-based coupon period index, if this is a coupon observation. */
  couponPeriod?: number;
  /** 1-based call period index, if this is a call observation. */
  callPeriod?: number;
}

/** Thin export: reused by src/engine/combinators, the additive DSL layer,
 * to build its own schedule-driven contract trees without duplicating the
 * merge logic. Pure function, no behavior change. */
export function mergeEvents(grid: PricingGrid): CouponEvent[] {
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

/** Call barrier, decimal, for example 1.00 = 100%, for 1-based call
 * period j. Thin export: reused by src/engine/combinators. This is a pure
 * numeric helper, with no path dependence, so it is safe to share. */
export function callBarrierDecimal(spec: CouponProductSpec, j: number): number {
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

/** Thin export: reused by src/engine/combinators. */
export function isCallable(spec: CouponProductSpec, j: number): boolean {
  return (
    j >= spec.callFromPeriod &&
    (spec.callType === 'constant' || spec.callType === 'stepdown' || spec.callType === 'custom')
  );
}

/** Autocall coupon paid on redemption — at call, or, in the extractor,
 * hypothetical — at period j. Thin export: reused by src/engine/combinators. */
export function redemptionCostPctAt(spec: CouponProductSpec, j: number): number {
  switch (spec.acCouponType) {
    case 'flat':
      return 100 + spec.acCouponPct;
    case 'snowball':
      return 100 + (spec.acCouponPct * j) / PERIODS_PER_YEAR[spec.callFrequency];
    default:
      return 100;
  }
}

/** Thin export: reused by src/engine/combinators. */
export function couponAmountPct(spec: CouponProductSpec): number {
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
  // Industry-standard geared put: leverage multiplies the raw shortfall,
  // not the shortfall normalized by strike. So, for example, strike 80 with
  // leverage 125% redeems to exactly 0 on a 100% stock decline.
  const shortfall = Math.max(0, spec.putStrikePct - 100 * perfT);
  return Math.max(0, 100 - (spec.downsideLeveragePct / 100) * shortfall);
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

// ---------------------------------------------------------------------------
// Observables split (Phase A / Phase B). Mirrors makeCouponEvaluator's
// arithmetic and iteration order exactly. See tests/observables.test.ts for
// the per-path equivalence proof. Phase A (`makeCouponObservables`) depends
// only on `ctx.grid`, the merged coupon-and-call observation schedule,
// never on `spec`. So it can be cached and reused across solve iterations
// that vary spec numeric parameters, such as barriers or coupon rates,
// while the schedule stays fixed. Phase B (`makeCouponOutcome`) is the
// cheap per-iteration part.
// ---------------------------------------------------------------------------

/**
 * Coupon products never read `maxPerf`, only `minPerf`, for American KI
 * monitoring — see kiEventFromObs below. It is always safe to skip
 * tracking `maxPerf`.
 */
export function couponObservablesRequirements(spec: CouponProductSpec): ObservablesRequirements {
  return { needsMin: spec.barrierType === 'american', needsMax: false };
}

/** Phase A: precompute terminal and running perf, plus perf at each merged
 * coupon or call observation, once per path. `req` is derived from the
 * spec's monitoring MODE only, never barrier levels — see
 * `couponObservablesRequirements`. It says which of minPerf/maxPerf are
 * actually read downstream. Skipping the unused one keeps the per-step
 * work to what the spec's monitoring mode needs, without losing
 * cacheability across a barrier-level solve, because the mode, and so
 * `req`, stays fixed. */
export function makeCouponObservables(ctx: EvaluatorContext, req: ObservablesRequirements): ObservablesEvaluator {
  const { grid } = ctx;
  const events = mergeEvents(grid);
  const eventIndices = events.map((e) => e.gridIndex);
  const nEvents = eventIndices.length;
  const { needsMin, needsMax } = req;

  return (spots: Float64Array): PathObservables => {
    const S0 = spots[0];
    const nSteps = spots.length - 1;
    const eventPerf = new Float64Array(nEvents);
    let ei = 0;
    let minPerf = needsMin ? Infinity : NaN;
    let maxPerf = needsMax ? -Infinity : NaN;

    for (let i = 1; i <= nSteps; i++) {
      const p = spots[i] / S0;
      if (needsMin && p < minPerf) minPerf = p;
      if (needsMax && p > maxPerf) maxPerf = p;
      if (ei < nEvents && eventIndices[ei] === i) {
        eventPerf[ei] = p;
        ei++;
      }
    }

    return { perfT: spots[nSteps] / S0, minPerf, maxPerf, eventPerf };
  };
}

/** Observables-based equivalent of kiEventFor: same branches, same
 * operands. obs.perfT and obs.minPerf are bit-identical to the spots-based
 * computation, because they are the same division and loop, just computed
 * once and cached. */
function kiEventFromObs(spec: CouponProductSpec, obs: PathObservables): boolean | undefined {
  switch (spec.barrierType) {
    case 'none':
      return undefined;
    case 'european':
      return obs.perfT < spec.kiBarrierPct / 100;
    case 'american':
      return obs.minPerf < spec.kiBarrierPct / 100;
  }
}

function isKnockedInFromObs(spec: CouponProductSpec, obs: PathObservables): boolean {
  if (spec.barrierType === 'none') return true;
  return kiEventFromObs(spec, obs) === true;
}

function maturityRedemptionPctFromObs(spec: CouponProductSpec, obs: PathObservables): number {
  const ki = isKnockedInFromObs(spec, obs);
  if (!ki) return 100;
  const shortfall = Math.max(0, spec.putStrikePct - 100 * obs.perfT);
  return Math.max(0, 100 - (spec.downsideLeveragePct / 100) * shortfall);
}

/** Phase B: apply spec terms to precomputed observables. Identical
 * arithmetic and iteration order to makeCouponEvaluator's per-path
 * closure. */
export function makeCouponOutcome(spec: CouponProductSpec, ctx: EvaluatorContext): OutcomeEvaluator {
  const { grid } = ctx;
  const events = mergeEvents(grid);
  const coupon = couponAmountPct(spec);

  return (obs: PathObservables): PathOutcome => {
    let pvPct = 0;
    let missed = 0;

    for (let idx = 0; idx < events.length; idx++) {
      const ev = events[idx];
      const perf = obs.eventPerf[idx];

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
    const redemption = maturityRedemptionPctFromObs(spec, obs);
    pvPct += ctx.df(timeOf(nSteps, grid)) * redemption;

    return {
      pvPct,
      kiEvent: kiEventFromObs(spec, obs),
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
