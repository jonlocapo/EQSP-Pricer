// Shared wiring for the product pages (CouponPage, ParticipationPage,
// AccumulatorPage). Each page assembles its own product spec and terms —
// that stays separate, product by product — but the solve-target plumbing
// around it is identical, so it lives here once.
import { useMarketStore, type BasketLegState } from '../state/marketStore';
import type { SolveTarget } from '../model/request';

/** Tolerance for the AUTO downside-leverage write-back. Guards against a
 * redundant re-render when the computed leverage already matches the
 * stored value to within rounding. */
export const AUTO_LEVERAGE_EPS = 0.01;

/** Standard downside leverage: 1/strikePct so a 100% underlying decline
 * exhausts the leveraged leg exactly. Shared by the Coupon page (put
 * strike) and the Participation page (downside strike) — same formula,
 * same rounding, different field name for the input. */
export function autoDownsideLeverage(strikePct: number): number {
  if (!(strikePct > 0)) return 100;
  return Math.round((10000 / strikePct) * 100) / 100;
}

/** "Price (reoffer)" is solve kind 'none'. Every solve-driven page shows
 * "Solve" once any other target is active, and "Price" otherwise. */
export function priceLabelFor(solve: SolveTarget): 'Price' | 'Solve' {
  return solve.kind === 'none' ? 'Price' : 'Solve';
}

/** Builds the per-field `fieldSolved` check that dims/highlights a
 * NumericField's solve chip. A field reads as solved only when it is the
 * CURRENT solve target. */
export function makeFieldSolved(solve: SolveTarget) {
  return function fieldSolved(kind: SolveTarget['kind']): boolean {
    return solve.kind === kind;
  };
}

/** Builds the radio-semantics solve toggle shared by the Coupon and
 * Participation pages: clicking a chip activates that target and
 * deactivates all others; clicking the already-active chip falls back to
 * Price. The Accumulator page has no 'none' solve state, so it uses its
 * own plain select instead of this toggle. */
export function makeToggleSolve(solve: SolveTarget, setSolve: (s: SolveTarget) => void) {
  return function toggleSolve(kind: Exclude<SolveTarget['kind'], 'none'>): void {
    setSolve(solve.kind === kind ? { kind: 'none' } : ({ kind } as SolveTarget));
  };
}

/** The live leg list, primary leg first, so it always reflects whatever
 * TickerSearch and the basket panel currently show — a spec's `underlyings`
 * field is never edited directly, only assembled here (see model/basket.ts).
 * Shared by the Coupon and Participation pages, the two products with a
 * basket leg list; the Accumulator page is single-underlying only. */
export function usePricingSpec<T extends object>(
  spec: T,
): {
  underlyingName: string;
  extraLegs: BasketLegState[];
  underlyings: { name: string }[];
  pricingSpec: T & { underlyings: { name: string }[] };
} {
  const underlyingName = useMarketStore((s) => s.underlyingName);
  const extraLegs = useMarketStore((s) => s.extraLegs);
  const underlyings = [{ name: underlyingName }, ...extraLegs.map((l) => ({ name: l.name }))];
  const pricingSpec = { ...spec, underlyings };
  return { underlyingName, extraLegs, underlyings, pricingSpec };
}
