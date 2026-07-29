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
 *
 * With `opts` (rate and dividend yield), `buildVolSurface` computes each
 * point's vol itself by inverting the quote's own PRICE (see
 * ../model/impliedFromQuote and ../engine/impliedVol), instead of trusting
 * the source's `iv` field, which is quietly computed against the SOURCE's
 * own rate/dividend assumptions rather than this engine's. In that mode it
 * also runs a set of model-free no-arbitrage filters on the raw prices —
 * see `filterArbitrageFree` and `repairCalendarArbitrage` below — because a
 * computed surface is only as trustworthy as the prices that fed it.
 * Without `opts`, behavior is unchanged from before: provider `iv` only,
 * no price-based filtering.
 */
import { volFromQuote } from './impliedFromQuote';

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
  /** True when every point on this surface carries the SAME vol (no skew,
   * possibly still a term structure across maturities). Set by the
   * builders that construct a genuinely flat surface (see volPipeline's
   * `flatSurface` and `buildRealizedSurface` with zero effective skew),
   * never inferred after the fact. A flat surface returns the same vol
   * regardless of which strike it is read at, so a caller may read
   * `market.vol` directly instead of interpolating — see
   * worker/pricing.ts's `effectiveMarketFor`. */
  isFlat?: boolean;
}

interface RawQuote {
  strike: number;
  iv?: number;
  bid?: number;
  ask?: number;
  last?: number;
}

interface ChainLikeSlice {
  tYears: number;
  calls: RawQuote[];
  puts: RawQuote[];
}

interface ChainLike {
  spot: number;
  slices: ChainLikeSlice[];
  source: string;
}

export interface BuildVolSurfaceOpts {
  /** Continuously compounded rate, needed to invert a quote's PRICE. */
  rate?: number;
  /** Continuous dividend yield, needed to invert a quote's PRICE. */
  divYield?: number;
}

const MIN_IV = 0.005;
const MAX_IV = 3;

/** Mirrors ../model/impliedFromQuote's own price selection (mid of a
 * two-sided market, else the last trade), so the arbitrage filters below
 * check the SAME price that fed the inversion, not a different one. */
function quotePrice(q: RawQuote): number | undefined {
  if (q.bid !== undefined && q.ask !== undefined && q.bid > 0 && q.ask > 0 && q.ask >= q.bid) {
    return (q.bid + q.ask) / 2;
  }
  if (q.last !== undefined && q.last > 0) return q.last;
  return undefined;
}

interface ResolvedPoint {
  strike: number;
  iv: number;
  price?: number;
}

/**
 * Model-free no-arbitrage filters, run on one side (calls or puts) of one
 * expiry slice, ascending by strike. Both relations hold for ANY
 * consistent option pricing, Black-Scholes or otherwise, so a violation
 * means the QUOTE is inconsistent, not that the model is wrong:
 *
 *  - STRIKE MONOTONICITY. A call's price is non-increasing in strike; a
 *    put's is non-decreasing. A quote that breaks the required direction
 *    relative to the strike before it is dropped outright.
 *  - BUTTERFLY CONVEXITY. Price is a CONVEX function of strike: the price
 *    at an interior strike can never sit above the straight line (chord)
 *    joining its two neighbors' prices, by more than a small numerical
 *    tolerance. A violation means the MIDDLE quote is inconsistent with
 *    its neighbors, so it is dropped and its former neighbors are
 *    re-checked against each other — removing one bad point can reveal or
 *    resolve a violation elsewhere in the remaining triple.
 *
 * Only quotes that carry a real market PRICE (see `quotePrice`) are
 * checked; a point resolved purely from a provider's `iv`, with no
 * bid/ask/last behind it, has nothing here to validate and passes through
 * untouched.
 */
function filterArbitrageFree(side: ResolvedPoint[], isCall: boolean): ResolvedPoint[] {
  const priced = side.filter((q): q is ResolvedPoint & { price: number } => q.price !== undefined);
  const unpriced = side.filter((q) => q.price === undefined);
  if (priced.length === 0) return side;

  const monotone: (ResolvedPoint & { price: number })[] = [];
  for (const q of priced) {
    const prev = monotone[monotone.length - 1];
    const ok = !prev || (isCall ? q.price <= prev.price : q.price >= prev.price);
    if (ok) monotone.push(q);
    // else: dropped — contradicts the accepted, less extreme-strike neighbor.
  }

  let arr = monotone;
  let changed = true;
  while (changed && arr.length >= 3) {
    changed = false;
    for (let i = 1; i < arr.length - 1; i++) {
      const k1 = arr[i - 1];
      const k2 = arr[i];
      const k3 = arr[i + 1];
      const w = (k2.strike - k1.strike) / (k3.strike - k1.strike);
      const chordAtK2 = k1.price + w * (k3.price - k1.price);
      const tol = 1e-6 * Math.max(k1.price, k2.price, k3.price, 1e-8);
      if (k2.price > chordAtK2 + tol) {
        arr = arr.filter((_, idx) => idx !== i);
        changed = true;
        break;
      }
    }
  }

  return [...arr, ...unpriced].sort((a, b) => a.strike - b.strike);
}

/**
 * Calendar-arbitrage repair across maturities: total variance, iv^2 * t,
 * must be non-decreasing in T at fixed strike, because `volAt` interpolates
 * across maturity linearly in total variance (see the module doc) — that
 * interpolation silently assumes this holds. Checked at strikes that
 * appear, EXACTLY, in more than one slice (the common case for a real
 * listed chain, where strikes are standardized increments). A violation is
 * REPAIRED, not dropped: the later slice's vol at that strike is raised to
 * the minimum level consistent with a non-decreasing term structure. A
 * repair preserves the skew shape at that maturity; dropping the point
 * would silently erase it instead.
 */
function repairCalendarArbitrage(slices: VolSlice[]): void {
  for (let i = 1; i < slices.length; i++) {
    const prior = slices[i - 1];
    const cur = slices[i];
    for (const pt of cur.points) {
      const priorPt = prior.points.find((p) => p.strike === pt.strike);
      if (!priorPt) continue;
      const priorVariance = priorPt.iv * priorPt.iv * prior.tYears;
      const curVariance = pt.iv * pt.iv * cur.tYears;
      if (curVariance < priorVariance) {
        pt.iv = Math.sqrt(priorVariance / cur.tYears);
      }
    }
  }
}

/**
 * Builds a surface from an option chain using the OTM composite smile: puts
 * below spot, calls at or above spot. Those are the liquid, informative
 * quotes on each side. This avoids mixing two different vols at the same
 * strike.
 */
export function buildVolSurface(chain: ChainLike, opts?: BuildVolSurfaceOpts): VolSurface {
  const useComputed = opts?.rate !== undefined && opts?.divYield !== undefined;
  const usableProviderIv = (iv: number | undefined): iv is number => iv !== undefined && iv > MIN_IV && iv < MAX_IV;

  const resolveSide = (quotes: RawQuote[], tYears: number, isCall: boolean): ResolvedPoint[] => {
    const out: ResolvedPoint[] = [];
    for (const q of quotes) {
      if (useComputed) {
        const result = volFromQuote(q, chain.spot, q.strike, tYears, opts!.rate!, opts!.divYield!, isCall);
        if (result) out.push({ strike: q.strike, iv: result.vol, price: quotePrice(q) });
      } else if (usableProviderIv(q.iv)) {
        out.push({ strike: q.strike, iv: q.iv });
      }
    }
    return out;
  };

  const slices: VolSlice[] = [];
  for (const s of chain.slices) {
    let putSide = resolveSide(
      s.puts.filter((p) => p.strike < chain.spot),
      s.tYears,
      false,
    );
    let callSide = resolveSide(
      s.calls.filter((c) => c.strike >= chain.spot),
      s.tYears,
      true,
    );

    if (useComputed) {
      putSide = filterArbitrageFree(putSide, false);
      callSide = filterArbitrageFree(callSide, true);
    }

    const points = [...putSide, ...callSide].map(({ strike, iv }) => ({ strike, iv }));
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
  if (useComputed) repairCalendarArbitrage(slices);
  return { spotRef: chain.spot, slices, source: chain.source };
}

/**
 * Interpolation within one expiry: linear in LOG-MONEYNESS ln(K/spotRef),
 * not raw strike, and linear in TOTAL VARIANCE (iv^2, maturity is fixed
 * within one slice so iv^2 and iv^2*t share the same shape here), not raw
 * vol. Flat outside the quoted range.
 *
 * WHY log-moneyness: strike is not the natural coordinate for a smile — a
 * $10 move means something completely different at a $20 strike and at a
 * $2000 strike, but the SAME log-moneyness move means the same thing at
 * both. This is the standard SVI-style convention and it is also the same
 * convention this file already uses across MATURITY (see `volAt`'s total-
 * variance interpolation below); using raw strike for the strike axis while
 * using variance for the time axis was an inconsistency.
 *
 * WHY total variance, not raw vol: variance is what actually enters the
 * option price (through vol^2 * t), so it is the quantity a genuinely
 * arbitrage-consistent interpolation should be linear in, not vol itself.
 */
function ivAtStrike(slice: VolSlice, strike: number, spotRef: number): number {
  const pts = slice.points;
  const xAt = (k: number) => Math.log(Math.max(k, 1e-12) / spotRef);
  const x = xAt(strike);
  if (x <= xAt(pts[0].strike)) return pts[0].iv;
  const last = pts[pts.length - 1];
  if (x >= xAt(last.strike)) return last.iv;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const bx = xAt(b.strike);
    if (x <= bx) {
      const ax = xAt(a.strike);
      const w = (x - ax) / (bx - ax);
      const varA = a.iv * a.iv;
      const varB = b.iv * b.iv;
      const variance = varA + w * (varB - varA);
      return Math.sqrt(Math.max(0, variance));
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
  const { slices, spotRef } = surface;
  if (slices.length === 1 || tYears <= slices[0].tYears) {
    return ivAtStrike(slices[0], strike, spotRef);
  }
  const last = slices[slices.length - 1];
  if (tYears >= last.tYears) return ivAtStrike(last, strike, spotRef);

  for (let i = 1; i < slices.length; i++) {
    const a = slices[i - 1];
    const b = slices[i];
    if (tYears <= b.tYears) {
      const ivA = ivAtStrike(a, strike, spotRef);
      const ivB = ivAtStrike(b, strike, spotRef);
      // Interpolate total variance w = iv^2 * t, then back out the vol.
      const varA = ivA * ivA * a.tYears;
      const varB = ivB * ivB * b.tYears;
      const w = (tYears - a.tYears) / (b.tYears - a.tYears);
      const variance = varA + w * (varB - varA);
      return Math.sqrt(Math.max(0, variance) / tYears);
    }
  }
  return ivAtStrike(last, strike, spotRef);
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
