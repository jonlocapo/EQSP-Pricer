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
  /** Reduced path count used when `PriceRequest.preview` is set — fast,
   * slightly noisier pricing for live-typing feedback. Defaults to
   * DEFAULT_PREVIEW_PATHS (src/worker/pricing.ts) when omitted. */
  previewNumPaths?: number;
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
  /** When true, price/solve at `mc.previewNumPaths` instead of
   * `mc.numPaths` — a fast, transient/advisory pass used while the user is
   * actively editing. The path cache keys on numPaths, so preview and full
   * runs naturally live in separate cache entries. */
  preview?: boolean;
  /** Previously-solved value (in the solve target's natural unit) to seed a
   * tight bracket around, instead of cold-starting the root find from
   * [lo, hi]. Ignored when solve.kind is 'none'/'upfront'. Falls back to a
   * full cold-start bracket expansion if the tight bracket doesn't actually
   * contain the root. */
  warmStartValue?: number;
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
  /** True if the solver's warm-start tight bracket actually contained the
   * root (converged in the fast path); false/undefined if it cold-started
   * (no warmStartValue given, or the warm guess was bad and it fell back). */
  solveWarmStart?: boolean;
  greeks?: Greeks;
  diagnostics: Diagnostics;
  elapsedMs: number;
  /** Echoes PriceRequest.preview — a transient/advisory result at reduced
   * path count, not yet the settled full-precision price. */
  preview?: boolean;
}
