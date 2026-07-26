/**
 * Implied-volatility surface built by interpolating a fetched option chain.
 *
 * WHY this exists: without it, the engine prices every product on a single
 * flat volatility. But structured-product payoffs are concentrated away
 * from the money. A knock-in put at 60% of spot lives entirely in the left
 * tail, where equity implied vol is materially higher than ATM. Pricing it
 * at ATM vol understates that leg.
 *
 * WHAT this is NOT: an arbitrage-free model. There is no SVI/SSVI fit and
 * no Dupire local volatility here. It interpolates quoted implied vols and
 * lets a payoff be priced at the vol of ITS OWN risk strike, the standard
 * practitioner shortcut. It captures the first-order skew effect honestly
 * and cheaply. A local-vol Monte Carlo would be the rigorous successor.
 *
 * Interpolation choices:
 *  - across STRIKE: linear in the quoted vols, clamped flat outside the
 *    quoted range, so an extreme barrier never extrapolates to a silly vol;
 *  - across MATURITY: linear in TOTAL VARIANCE (iv^2 * t), rather than in
 *    vol. This is the standard, better-behaved choice, and it is exact
 *    when the term structure of variance is piecewise linear.
 */

export interface VolSlice {
  tYears: number;
  /** Ascending by strike. At least one point. */
  points: { strike: number; iv: number }[];
}

export interface VolSurface {
  /** Spot at build time — lets callers address the surface by % of spot. */
  spotRef: number;
  /** Ascending by tYears. At least one slice. */
  slices: VolSlice[];
  source: string;
}

interface ChainLikeSlice {
  tYears: number;
  calls: { strike: number; iv?: number }[];
  puts: { strike: number; iv?: number }[];
}

interface ChainLike {
  spot: number;
  slices: ChainLikeSlice[];
  source: string;
}

const MIN_IV = 0.005;
const MAX_IV = 3;

/**
 * Builds a surface from an option chain using the OTM composite smile: puts
 * below spot, calls at or above spot. Those are the liquid, informative
 * quotes on each side. This avoids mixing two different vols at the same
 * strike.
 */
export function buildVolSurface(chain: ChainLike): VolSurface {
  const usable = (iv: number | undefined): iv is number => iv !== undefined && iv > MIN_IV && iv < MAX_IV;

  const slices: VolSlice[] = [];
  for (const s of chain.slices) {
    const points: { strike: number; iv: number }[] = [];
    for (const p of s.puts) {
      if (p.strike < chain.spot && usable(p.iv)) points.push({ strike: p.strike, iv: p.iv });
    }
    for (const c of s.calls) {
      if (c.strike >= chain.spot && usable(c.iv)) points.push({ strike: c.strike, iv: c.iv });
    }
    points.sort((a, b) => a.strike - b.strike);
    // Collapse duplicate strikes (a chain can quote both sides at spot).
    const deduped: { strike: number; iv: number }[] = [];
    for (const p of points) {
      const prev = deduped[deduped.length - 1];
      if (prev && prev.strike === p.strike) prev.iv = (prev.iv + p.iv) / 2;
      else deduped.push({ ...p });
    }
    if (deduped.length > 0 && s.tYears > 0) slices.push({ tYears: s.tYears, points: deduped });
  }

  slices.sort((a, b) => a.tYears - b.tYears);
  if (slices.length === 0) {
    throw new Error('Option chain had no usable implied vols, so no surface can be built');
  }
  return { spotRef: chain.spot, slices, source: chain.source };
}

/** Linear-in-strike interpolation within one expiry, flat outside its range. */
function ivAtStrike(slice: VolSlice, strike: number): number {
  const pts = slice.points;
  if (strike <= pts[0].strike) return pts[0].iv;
  const last = pts[pts.length - 1];
  if (strike >= last.strike) return last.iv;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (strike <= b.strike) {
      const w = (strike - a.strike) / (b.strike - a.strike);
      return a.iv + w * (b.iv - a.iv);
    }
  }
  return last.iv;
}

/**
 * Implied vol at an absolute strike and maturity. Maturity interpolation is
 * in total variance. Outside the quoted maturity range, the nearest
 * slice's vol is held flat and never extrapolated.
 */
export function volAt(surface: VolSurface, strike: number, tYears: number): number {
  const { slices } = surface;
  if (slices.length === 1 || tYears <= slices[0].tYears) {
    return ivAtStrike(slices[0], strike);
  }
  const last = slices[slices.length - 1];
  if (tYears >= last.tYears) return ivAtStrike(last, strike);

  for (let i = 1; i < slices.length; i++) {
    const a = slices[i - 1];
    const b = slices[i];
    if (tYears <= b.tYears) {
      const ivA = ivAtStrike(a, strike);
      const ivB = ivAtStrike(b, strike);
      // Interpolate total variance w = iv^2 * t, then back out the vol.
      const varA = ivA * ivA * a.tYears;
      const varB = ivB * ivB * b.tYears;
      const w = (tYears - a.tYears) / (b.tYears - a.tYears);
      const variance = varA + w * (varB - varA);
      return Math.sqrt(Math.max(0, variance) / tYears);
    }
  }
  return ivAtStrike(last, strike);
}

/** Implied vol addressed by % of the surface's reference spot (100 = ATM). */
export function volAtPctOfSpot(surface: VolSurface, strikePct: number, tYears: number): number {
  return volAt(surface, (strikePct / 100) * surface.spotRef, tYears);
}

/**
 * Skew steepness as a diagnostic: the vol difference between a low strike
 * and ATM at the given maturity, in vol points. Positive for a normal
 * equity skew. Useful for showing the user WHY a skew-aware price differs
 * from the flat-vol one.
 */
export function skewPoints(surface: VolSurface, tYears: number, lowStrikePct = 80): number {
  return volAtPctOfSpot(surface, lowStrikePct, tYears) - volAtPctOfSpot(surface, 100, tYears);
}
