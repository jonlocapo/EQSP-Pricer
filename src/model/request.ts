import type { MarketData } from './market';
import type { ProductSpec } from './product';

/**
 * Solve targets. The solver finds x such that PV%(x) equals the spec's
 * reofferPct (coupon/participation) or upfrontPct (accumulator).
 * 'none' = plain pricing. Availability is product-dependent (see
 * solveAvailability in engine/payoffs) — e.g. barrier solves are disabled
 * for issuerCallable and custom call schedules.
 */
export type SolveTarget =
  | { kind: 'none' }
  // coupon page
  | { kind: 'couponPa' }
  | { kind: 'acCouponPa' }
  | { kind: 'couponBarrier' }
  | { kind: 'callBarrier' }
  | { kind: 'kiBarrier' }
  // participation page
  | { kind: 'gearing' }
  | { kind: 'upsideStrike' }
  | { kind: 'bonusLevel' }
  | { kind: 'twinWin' }
  | { kind: 'upperStrike' }
  | { kind: 'upsideKoBarrier' }
  | { kind: 'rebate' }
  // accumulator page
  | { kind: 'strike' }
  | { kind: 'upfront' };

export interface McSettings {
  numPaths: number;
  seed: number;
  antithetic: boolean;
}

export const DEFAULT_MC: McSettings = { numPaths: 100_000, seed: 42, antithetic: true };

export interface PriceRequest {
  /** Correlates progress/result/cancel messages. */
  id: string;
  product: ProductSpec;
  market: MarketData;
  mc: McSettings;
  solve: SolveTarget;
  /** Compute delta/vega by bump-and-reprice (3x cost). */
  greeks: boolean;
}

export interface Greeks {
  /** dPV% per +1% relative spot bump. */
  deltaPct: number;
  /** dPV% per +1 vol point. */
  vegaPct: number;
}

export interface Diagnostics {
  /** P(called at observation j), coupon page only. */
  callProb?: number[];
  /** P(knock-in event), pages 1-2. */
  kiProb?: number;
  /** P(upside KO), participation koRebate only. */
  upsideKoProb?: number;
  /** P(accumulator knocked out before maturity). */
  koProb?: number;
  expectedLifeYears?: number;
  /** Distribution of per-path (or per-antithetic-pair) PV% outcomes, ~24
   * evenly-spaced bins. Absent for the issuerCallable/LSMC branch (out of
   * scope — see engine/lsmc.ts). */
  histogram?: { binEdges: number[]; counts: number[] };
  /** P(sample < reference level). Coupon/participation: reference is
   * issuePricePct. Accumulator: reference is 0 (P&L is already expressed in
   * % of notional, so "loss" means negative P&L rather than a price paid). */
  pLoss?: number;
  /** Mean of the worst 5% of samples, pvPct units. */
  expectedShortfall5?: number;
  /** Mean of the worst 1% of samples, pvPct units. */
  expectedShortfall1?: number;
}

export interface PriceResult {
  id: string;
  /** PV as % of notional (accumulator: % of estimated notional). */
  pvPct: number;
  pvCcy: number;
  stderrPct: number;
  ci95Pct: [number, number];
  /** Present when solve.kind !== 'none'; in the target's natural unit. */
  solvedValue?: number;
  solveIterations?: number;
  greeks?: Greeks;
  diagnostics: Diagnostics;
  elapsedMs: number;
}
