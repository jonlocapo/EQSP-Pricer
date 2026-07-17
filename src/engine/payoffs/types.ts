import type { MarketData } from '../../model/market';
import type { ProductSpec } from '../../model/product';

/**
 * Contract between the MC engine (path generation, pricing loop, LSMC) and
 * the product payoff evaluators. Evaluators are pure functions of a path so
 * they can be exercised in tests with hand-built literal arrays.
 */

/** Daily simulation grid plus product observation schedules (grid indices). */
export interface PricingGrid {
  /** Number of daily steps; spots arrays have nSteps + 1 entries (S0 first). */
  nSteps: number;
  /** Year fraction of one step (1/252). */
  dtYears: number;
  tenorYears: number;
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

export const timeOf = (gridIndex: number, grid: PricingGrid): number => gridIndex * grid.dtYears;

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
