/**
 * Which strike a product's dominant optionality actually sits at.
 *
 * The Monte Carlo runs on ONE volatility, so to make a skew-aware price the
 * engine has to choose WHICH point of the surface to price at. Using ATM is
 * what the flat-vol engine effectively did, and it is wrong for these payoffs:
 * a knock-in put with a 60% barrier lives entirely in the left tail, where
 * equity implied vol is materially higher.
 *
 * The rule below picks the strike where each family's dominant leg lives, as a
 * % of the initial fixing. It is a deliberate approximation — one vol per
 * product, not a consistent surface — and the direction it moves prices is
 * economically meaningful: for downside-bearing notes it raises the vol used,
 * which makes the short put dearer and therefore RAISES the fair coupon.
 */
import type { ProductSpec } from '../model/product';

export interface RiskStrikeChoice {
  /** Strike as a % of the initial fixing (100 = ATM). */
  strikePct: number;
  /** Human-readable reason, surfaced in the UI so the choice isn't a black box. */
  reason: string;
}

/**
 * For a knock-in structure the knock-in event and the resulting loss straddle
 * two levels: the barrier (which decides IF the put attaches) and the put
 * strike (which decides HOW MUCH is lost). The barrier governs the probability
 * and sits deepest in the tail, so it dominates the skew sensitivity; when
 * there is no barrier the put strike is the only relevant level.
 */
export function riskStrikeFor(spec: ProductSpec): RiskStrikeChoice {
  if (spec.kind === 'coupon') {
    if (spec.barrierType !== 'none') {
      return {
        strikePct: spec.kiBarrierPct,
        reason: `knock-in barrier at ${spec.kiBarrierPct}% governs the downside`,
      };
    }
    return {
      strikePct: spec.putStrikePct,
      reason: `put strike at ${spec.putStrikePct}% (no barrier)`,
    };
  }

  if (spec.kind === 'participation') {
    const d = spec.downside;
    if (d.barrierType !== 'none') {
      return {
        strikePct: d.kiBarrierPct,
        reason: `knock-in barrier at ${d.kiBarrierPct}% governs the downside`,
      };
    }
    if (d.leveragePct > 0) {
      return {
        strikePct: d.strikePct,
        reason: `downside strike at ${d.strikePct}%`,
      };
    }
    // Fully protected: the upside call is the only optionality left.
    return {
      strikePct: spec.upside.strikePct,
      reason: `upside strike at ${spec.upside.strikePct}% (downside protected)`,
    };
  }

  // Accumulator: the daily decision is whether spot is below the strike, and
  // the knock-out sits above it; the strike is where the optionality lives.
  return {
    strikePct: spec.strikePct,
    reason: `accumulation strike at ${spec.strikePct}%`,
  };
}
