import type { Cmp, Expr } from './expr';

/**
 * One schedule observation date (grid index) in a contract's merged
 * schedule. A date may carry a coupon leg, an autocall leg, both (e.g.
 * quarterly coupon + quarterly call coinciding), or neither (a pure
 * performance-observation date with no cashflow, not currently emitted by
 * the builders in products.ts but representable).
 *
 * `obsIndex` is this event's position (0-based, ascending) in the
 * contract's merged event-grid-index list; `perfAt(obsIndex)` expressions
 * read `obs.eventPerf[obsIndex]` for this date. Assigning it is the
 * contract builder's job (see products.ts) so that schedule construction
 * and Expr construction stay in lockstep.
 */
export interface ScheduleEvent {
  /** Grid index (steps from t=0) of this observation. */
  gridIndex: number;
  /** 1-based period index within whichever schedule(s) this event belongs
   * to — used only for PathOutcome.calledAtPeriod reporting. */
  period: number;
  coupon?: {
    condition: Cmp;
    amount: Expr;
    /** Phoenix/memory semantics: on a miss, accrue; on a hit, pay
     * amount * (1 + missed-count) and reset. Mirrors couponProducts.ts's
     * `missed` accumulator, applied by the compiler across events in
     * ascending order — this is deliberately NOT an Expr-DAG node, since it
     * is genuine cross-event state, not a pure function of one path point. */
    memory: boolean;
  };
  autocall?: {
    condition: Cmp;
    /** Amount paid (in place of anything else) if condition holds; the
     * contract's remaining events and maturity leg are never reached. */
    redemption: Expr;
  };
}

/**
 * A structured product expressed as a composable tree: an ascending
 * schedule of coupon/autocall events plus a maturity payoff `Expr`
 * evaluated only if no autocall event fires. `reporting` lets a contract
 * expose the boolean event flags the existing PathOutcome shape carries
 * (kiEvent/koEvent/upsideKoEvent) without baking their presence into the
 * payoff arithmetic itself — e.g. a plain RC (barrierType 'none') has no
 * kiEvent to report at all, matching makeCouponEvaluator's `undefined`.
 */
export interface Contract {
  /** Ascending by gridIndex, deduplicated — see mergeContractEvents. */
  events: ScheduleEvent[];
  maturity: Expr;
  /** Grid index at which the maturity leg is discounted/settled if reached
   * (normally grid.nSteps). */
  maturityGridIndex: number;
  /** Life reported at maturity (normally grid.tenorYears; a called path's
   * lifeYears is timeOf(event.gridIndex, grid), computed by the compiler). */
  maturityLifeYears: number;
  reporting?: {
    kiEvent?: Cmp;
    koEvent?: Cmp;
    upsideKoEvent?: Cmp;
  };
}
