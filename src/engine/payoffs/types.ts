import type { MarketData } from '../../model/market';
import type { ProductSpec } from '../../model/product';

/**
 * Contract between the MC engine (path generation, pricing loop, LSMC) and
 * the product payoff evaluators. Evaluators are pure functions of a path so
 * they can be exercised in tests with hand-built literal arrays.
 */

/**
 * Simulation grid plus product observation schedules (grid indices). Either
 * DAILY (nSteps = round(tenorYears*252), uniform step) for products that
 * need to walk every day — American barrier monitoring, the accumulator's
 * strike-dependent daily walk, issuer-callable LSMC — or COMPACT (step set =
 * the sorted, deduplicated union of the dates the payoff actually observes)
 * for European-only monitoring, where stepping straight from one observation
 * date to the next is mathematically EXACT under GBM (log-increments over a
 * longer dt are still exactly lognormal — not an approximation). See
 * schedule.ts's `buildGrid`/`needsDailyPath` for the decision.
 *
 * Steps need not be uniform (a merged coupon+call schedule, or a stub final
 * period, can produce different dt per step), so time is carried explicitly
 * via `times`/`stepDt` rather than derived from a single scalar dtYears.
 *
 * BIT-IDENTITY: for a daily (uniform) grid, `times[i] = i * dtYears` exactly
 * (a plain loop, not a cumulative sum of stepDt) and every `stepDt[i]` is
 * filled with the identical `dtYears` scalar (not `times[i+1]-times[i]`) —
 * cumulative summation or a subtraction would move discount factors in the
 * last ULP relative to the pre-adaptive-grid engine. This is what keeps
 * American/accumulator/LSMC products byte-identical across this change. For
 * a compact (non-uniform) grid, `times` comes directly from the real
 * observation times and `stepDt[i] = times[i+1] - times[i]`.
 */
export interface PricingGrid {
  /** Number of steps; spots arrays have nSteps + 1 entries (S0 first). */
  nSteps: number;
  /**
   * Year fraction of one step, for UNIFORM (daily) grids only. Kept for
   * backward compatibility (e.g. informational/debug use, and the
   * accumulator's `estimatedNotional` scaling by nSteps); never used to
   * derive time — see `times`/`timeOf`. For a compact grid this is just
   * tenorYears/nSteps, a representative average, not a real step size.
   */
  dtYears: number;
  tenorYears: number;
  /** Absolute time (years) of each grid point, length nSteps + 1.
   * times[0] = 0, times[nSteps] = tenorYears. */
  times: number[];
  /** Year fraction of each step, length nSteps. stepDt[i] is the dt from
   * times[i] to times[i+1]. */
  stepDt: Float64Array;
  /** Grid indices of coupon observation dates, ascending, last == nSteps. */
  couponObs: number[];
  /** Grid indices of call observation dates, ascending. Empty if callType 'none'. */
  callObs: number[];
  /**
   * Grid indices of accumulator settlement-period ends, ascending,
   * last == nSteps. Empty for non-accumulator products.
   */
  settlementObs: number[];
}

export const timeOf = (gridIndex: number, grid: PricingGrid): number => grid.times[gridIndex];

/** What happened on one simulated path. pvPct is the discounted PV, % of notional. */
export interface PathOutcome {
  pvPct: number;
  /** 1-based call observation period at which the note was called, if any. */
  calledAtPeriod?: number;
  kiEvent?: boolean;
  upsideKoEvent?: boolean;
  /** Accumulator knocked out (outside guarantee periods). */
  koEvent?: boolean;
  /** Effective life in years (call/KO date or tenor). */
  lifeYears: number;
}

/**
 * Evaluates one path. `spots` has grid.nSteps + 1 entries, spots[0] = S0.
 * Discounting happens inside the evaluator using the provided discount factor
 * function so path PVs can be averaged directly.
 */
export type PayoffEvaluator = (spots: Float64Array) => PathOutcome;

/**
 * The per-path functionals a solve-loop payoff decomposes into: the pieces
 * that depend only on the raw path + the observation index sets (couponObs/
 * callObs), NOT on any numeric spec parameter (barriers, coupon rates,
 * strikes, gearing). Computing these once per path and caching them lets a
 * Ridders solve iteration skip re-walking 253 steps × 100k paths on every
 * evaluation — see pathCache.ts.
 *
 * - `perfT`: terminal performance, spots[nSteps] / spots[0].
 * - `minPerf`: running minimum of spots[i] / spots[0] over i = 1..nSteps
 *   (American knock-in monitoring).
 * - `maxPerf`: running maximum of spots[i] / spots[0] over i = 1..nSteps
 *   (American knock-out / upside monitoring, e.g. koRebate).
 * - `eventPerf`: perf = spots[i] / spots[0] at each grid index of the coupon
 *   family's merged observation schedule (couponObs ∪ callObs), in the same
 *   ascending order as that schedule. Empty for participation, which only
 *   ever observes at nSteps (already covered by `perfT`).
 *
 * Only coupon and participation evaluators decompose this way (see
 * couponProducts.ts / participation.ts). The accumulator's daily walk
 * inherently depends on the strike (a solve target) at every step, so it is
 * left as a single monolithic evaluator — see accumulator.ts.
 */
export interface PathObservables {
  perfT: number;
  minPerf: number;
  maxPerf: number;
  eventPerf: Float64Array;
}

/**
 * Small descriptor of which running-extremum functionals a spec's
 * monitoring mode actually needs, so Phase A can skip tracking the unused
 * one(s) instead of computing minPerf AND maxPerf unconditionally on every
 * step of every path. Derived from the spec's monitoring MODE fields
 * (barrierType / koMonitoring) only — never from barrier LEVELS — so it
 * stays constant across a barrier-level solve and the observables cache
 * (keyed on this descriptor, see pathCache.ts's computeObservablesKey)
 * keeps hitting on every solve iteration.
 */
export interface ObservablesRequirements {
  needsMin: boolean;
  needsMax: boolean;
}

/** Phase A: path -> observables. Depends only on the grid (observation
 * index sets) and the requirements descriptor above, never on spec numeric
 * parameters. */
export type ObservablesEvaluator = (spots: Float64Array) => PathObservables;

/** Phase B: observables + spec (closed over) -> outcome. This is the cheap
 * part that varies per solve iteration. */
export type OutcomeEvaluator = (obs: PathObservables) => PathOutcome;

/** A payoff family that supports the observables split. `phaseB(phaseA(path))`
 * must be exactly reproducible as the family's monolithic PayoffEvaluator —
 * see tests/observables.test.ts. */
export interface SplitEvaluator {
  observables: ObservablesEvaluator;
  outcome: OutcomeEvaluator;
}

export interface EvaluatorContext {
  market: MarketData;
  grid: PricingGrid;
  /** Discount factor e^{-r t}. */
  df: (tYears: number) => number;
}

/**
 * Evaluator factory: precompute schedules/levels once, then evaluate many
 * paths. Implemented per product family in this directory; dispatched in
 * index.ts on spec.kind.
 */
export type EvaluatorFactory<S extends ProductSpec = ProductSpec> = (
  spec: S,
  ctx: EvaluatorContext,
) => PayoffEvaluator;

/**
 * Issuer-callable support (LSMC): the coupon evaluator additionally exposes
 * the note's cashflows per path with grid-index timing, so the LSMC module
 * can do backward induction over call dates. `redemptionCostPct(period)` is
 * what the issuer pays to call at that period (100 + accrued AC coupon).
 */
export interface PathCashflows {
  /** Grid indices, ascending; parallel to amountsPct. Includes maturity flow. */
  gridIndices: number[];
  /** Undiscounted amounts, % of notional. */
  amountsPct: number[];
}

export type CashflowExtractor = (spots: Float64Array) => PathCashflows;
