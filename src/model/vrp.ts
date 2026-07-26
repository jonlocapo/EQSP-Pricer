/**
 * The volatility risk premium (VRP) layer: pure functions that turn a
 * REALIZED vol surface into an IMPLIED-like one, when no real chain is
 * reachable but a volatility index gives at least one genuine implied
 * anchor.
 *
 * WHY a premium, and why it only scales UP: implied vol is what option
 * sellers demand to carry future realized risk, and on average that demand
 * exceeds the risk actually delivered — the well-documented volatility risk
 * premium. So realized vol sits below implied vol most of the time, and the
 * ratio implied/realized is the size of that premium. In a crash the
 * relation can invert (realized spikes above implied), but this app must
 * never SCALE A SURFACE DOWN on that basis — a below-1 reading is clamped
 * to 1 (no adjustment), never inverted into a discount.
 *
 * The ratio only rescales the LEVEL (the term structure). Skew and kurtosis
 * describe the SHAPE of the return distribution, which a risk premium does
 * not change — a risk premium is compensation for the general level of
 * uncertainty, not a statement about the distribution's tilt or tails.
 */
import type { RealizedMoments } from './realizedSurface';

/** A ratio of exactly 1 means "apply no premium" — never discount below the
 * measured realized level. */
export const MIN_RATIO = 1.0;
/** A generous cap. Vol indices can spike far above trailing realized vol in
 * a calm-then-scary transition; capping keeps a single noisy reading from
 * blowing up the whole surface. */
export const MAX_RATIO = 1.6;

/** A realized-vol term structure is anchored on the window closest to 30
 * calendar days, because that is the tenor a listed vol index quotes. */
const ANCHOR_T_YEARS = 21 / 252;

export interface VrpRatioOptions {
  minRatio?: number;
  maxRatio?: number;
}

/**
 * Ratio of an implied anchor (a vol-index level, decimal) to a short-horizon
 * realized vol (decimal), clamped to [minRatio, maxRatio]. Non-finite or
 * non-positive inputs degrade to `minRatio` — "apply no premium" — rather
 * than propagate NaN or an unbounded ratio into a surface.
 */
export function vrpRatio(impliedAnchor: number, realizedShort: number, opts: VrpRatioOptions = {}): number {
  const min = opts.minRatio ?? MIN_RATIO;
  const max = opts.maxRatio ?? MAX_RATIO;
  if (!(impliedAnchor > 0) || !(realizedShort > 0)) return min;
  const raw = impliedAnchor / realizedShort;
  if (!Number.isFinite(raw)) return min;
  return Math.min(max, Math.max(min, raw));
}

/**
 * Picks the realized term whose maturity is closest to the vol index's
 * quoted horizon (about 30 calendar days, the 21-trading-day window). Throws
 * if `terms` is empty — callers already require at least one term to build
 * anything.
 */
export function nearestAnchorTerm(
  terms: { tYears: number; vol: number }[],
  targetTYears: number = ANCHOR_T_YEARS,
): { tYears: number; vol: number } {
  if (terms.length === 0) throw new Error('Cannot pick an anchor term from an empty term structure');
  return terms.reduce((best, t) => (Math.abs(t.tYears - targetTYears) < Math.abs(best.tYears - targetTYears) ? t : best));
}

/** Multiplies every term's vol by `ratio`, leaving the maturities unchanged. */
export function scaleTermStructure(
  terms: { tYears: number; vol: number }[],
  ratio: number,
): { tYears: number; vol: number }[] {
  return terms.map((t) => ({ tYears: t.tYears, vol: t.vol * ratio }));
}

/**
 * Scales a realized-moments term structure by the VRP ratio. Skew and
 * excess kurtosis pass through unchanged — see the module comment for why.
 */
export function applyVrp(moments: RealizedMoments, ratio: number): RealizedMoments {
  return {
    terms: scaleTermStructure(moments.terms, ratio),
    skewDaily: moments.skewDaily,
    excessKurtDaily: moments.excessKurtDaily,
  };
}
