/**
 * Implied volatility from an observed option PRICE, by inverting Black-
 * Scholes. This is the correct way to build a vol input: a data provider
 * computes its own `iv` field using ITS OWN rate and dividend assumptions,
 * which do not match the rate and dividend this engine then uses to
 * discount and drift. A vol computed against a mismatched (r, q) pair is
 * not the vol this pricer means. Inverting the quoted price against OUR
 * OWN (r, q) removes that mismatch. Option prices are also far more widely
 * published than greeks, so inversion works on sources that never publish
 * an `iv` field at all.
 *
 * DESIGN, three ideas stacked together, each fixing a distinct numerical
 * failure mode:
 *
 * 1. PARITY PRECONDITIONING. An in-the-money quote is almost all intrinsic
 *    value, so vega is near zero there: a wide range of vols reproduces the
 *    quoted price to within the quote's own precision, which is the exact
 *    mechanism that produced a reported iv of 0.0001 on a deep-in-the-money
 *    AAPL call. Put-call parity, C - P = DF*(F - K), links every in-the-
 *    money option to an out-of-the-money one struck at the SAME level with
 *    the SAME implied vol (Black-Scholes is internally parity-consistent by
 *    construction). So an in-the-money quote is converted to its out-of-
 *    the-money twin before inversion. This does not manufacture precision
 *    the quote never had — a deep in-the-money quote with only a few
 *    significant digits still converts to an out-of-the-money price with
 *    only a few significant digits, and can still fail the time-value
 *    floor below — but it removes the near-zero-vega failure mode
 *    entirely, and it is exact under the model, not an approximation.
 *
 * 2. FORWARD, NORMALIZED SPACE. Working on the forward F = S*exp((r-q)T)
 *    with a single discount factor DF = exp(-rT) turns the two-rate
 *    problem into a one-parameter inversion for TOTAL vol sigma*sqrt(T),
 *    divided by sqrt(T) at the end. It costs fewer transcendental calls
 *    than repeatedly forming d1/d2 from (s, k, t, r, q) directly, and it
 *    stays correct under negative rates, which a naive (r - q) drift term
 *    can mishandle.
 *
 * 3. HALLEY ON LOG-PRICE, BRENT AS A GUARANTEED FALLBACK. Newton's method
 *    on vega alone converges quadratically but is still slow footed near
 *    the edges. Halley's method uses vomma (price's second derivative in
 *    vol) too, for cubic convergence, at the cost of one extra multiply
 *    since vomma is cheap once d1 and d2 are already known. The residual is
 *    matched in LOG price, not raw price, because an out-of-the-money price
 *    is exponentially small and a relative criterion on the log is far
 *    better conditioned than an absolute one on the price itself. This is
 *    the idea behind Jäckel's "Let's Be Rational" (which reaches machine
 *    precision in about two iterations); this module borrows the structure,
 *    not the full rational-approximation machinery. If a Halley step ever
 *    leaves the search bracket or the iteration fails to settle, `brent`
 *    (see ./solver) — bracketed, and so guaranteed to converge whenever a
 *    root exists in range — takes over. A caller never sees an unconverged
 *    value: either a value that has actually converged, or null.
 */
import { normCdf } from './blackScholes';
import { brent } from './solver';

export interface ImpliedVolQuery {
  /** Observed option price, same units as `s` and `k`. */
  price: number;
  /** Spot. */
  s: number;
  /** Strike. */
  k: number;
  /** Years to expiry. */
  t: number;
  /** Continuously compounded rate. */
  r: number;
  /** Continuous dividend yield. */
  q: number;
  isCall: boolean;
}

/**
 * Optional diagnostics, filled in when supplied. Exists so a test can pin
 * an iteration-count ceiling on the fast Halley path — catching a future
 * regression back to the slow, guaranteed-but-plodding brent fallback —
 * without changing the function's normal `number | null` contract.
 */
export interface ImpliedVolDiagnostics {
  /** Halley iterations taken (0 if the brent fallback ran instead). */
  iterations: number;
  /** True when the bracketed brent fallback had to run, either because a
   * Halley step left the search domain or because it did not settle within
   * the iteration budget. */
  usedFallback: boolean;
}

/**
 * Search bracket for the vol root, roughly 0.1% to 500%. A quote whose
 * price implies a root outside this range is a bad quote, not evidence of
 * an exotic true vol, so `impliedVolFromPrice` returns null rather than
 * clamping into the bracket.
 */
export const MIN_VOL = 0.001;
export const MAX_VOL = 5;

/**
 * A quote's (post-parity, out-of-the-money) price must clear this FRACTION
 * of the discounted forward before vol is considered recoverable. The
 * threshold is relative, not an absolute cent amount, because the same
 * absolute slack means nothing on a 5-dollar strike and everything on a
 * 5000-point index. It is applied AFTER parity preconditioning (see the
 * module doc): an in-the-money quote is judged on its out-of-the-money
 * twin's time value, not on the (structurally near-zero) time value
 * fraction of its own in-the-money price. This is what makes the floor
 * fire far less often than a naive per-quote check would.
 */
const MIN_TIME_VALUE_REL = 1e-6;

const MAX_HALLEY_ITER = 20;
/** Halley converges cubically; a well-conditioned quote should never need
 * more than this many steps. Kept well under MAX_HALLEY_ITER, which exists
 * as a hard stop, not a target. Exported so a test can pin it: a future
 * regression that silently degrades the fast path to something slower
 * should fail loudly here, not just cost a few extra microseconds. */
export const HALLEY_ITER_CEILING = 12;

const normPdf = (x: number): number => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/** Undiscounted Black-76 price plus its first and second derivatives in
 * TOTAL vol sigmaT = vol*sqrt(T) (vega and vomma), all from one pair of
 * (d1, d2). Vega is IDENTICAL for the call and the put at the same strike —
 * F*phi(d1) = K*phi(d2) — a standard Black-Scholes identity, so this single
 * formula serves both sides. */
function blackForward(
  fwd: number,
  k: number,
  sigmaT: number,
  isCall: boolean,
): { price: number; vega: number; vomma: number } {
  const d1 = (Math.log(fwd / k) + 0.5 * sigmaT * sigmaT) / sigmaT;
  const d2 = d1 - sigmaT;
  const price = isCall ? fwd * normCdf(d1) - k * normCdf(d2) : k * normCdf(-d2) - fwd * normCdf(-d1);
  const vega = fwd * normPdf(d1);
  // d(vega)/d(sigmaT) = vega * d1 * d2 / sigmaT (standard Black-Scholes vomma identity).
  const vomma = (vega * d1 * d2) / sigmaT;
  return { price, vega, vomma };
}

/**
 * The implied vol, or null when the quote cannot support one. Never
 * throws and never guesses: every rejection path below is a deliberate
 * "this quote does not carry a usable vol", not an error condition.
 */
export function impliedVolFromPrice(input: ImpliedVolQuery, diag?: ImpliedVolDiagnostics): number | null {
  const { price, s, k, t, r, q, isCall } = input;
  if (!(t > 0) || !(s > 0) || !(k > 0) || !(price > 0)) return null;

  const sqrtT = Math.sqrt(t);
  const fwd = s * Math.exp((r - q) * t);
  const df = Math.exp(-r * t);

  // Parity preconditioning (see module doc, point 1): always solve the
  // OUT-OF-THE-MONEY leg. C - P = DF*(F - K). An in-the-money call becomes
  // an out-of-the-money put at the same strike and the same vol; an in-the-
  // money put becomes an out-of-the-money call. "Out of the money" is
  // judged against the FORWARD, which is the correct moneyness reference
  // under a nonzero dividend yield or rate, not against spot.
  let undiscPrice = price / df;
  let isCallEff = isCall;
  if (isCall && k < fwd) {
    undiscPrice -= fwd - k;
    isCallEff = false;
  } else if (!isCall && k > fwd) {
    undiscPrice += fwd - k; // fwd - k < 0 here, so this reduces the price.
    isCallEff = true;
  }

  // Post-transform, the instrument is out-of-the-money (or exactly at the
  // forward), so its forward-space intrinsic value is exactly zero: the
  // whole no-arbitrage band is [0, min(F, K)], and undiscPrice IS the time
  // value, with no separate intrinsic to subtract back out.
  const upperBound = isCallEff ? fwd : k;
  if (!(undiscPrice > 0) || undiscPrice > upperBound) return null;

  const scale = Math.max(fwd, k);
  if (!(scale > 0) || undiscPrice / scale < MIN_TIME_VALUE_REL) return null;

  const sigmaTLo = MIN_VOL * sqrtT;
  const sigmaTHi = MAX_VOL * sqrtT;
  const lnTarget = Math.log(undiscPrice);

  // Seed: Brenner-Subrahmanyam's at-the-money approximation, adapted to
  // forward/undiscounted terms (undiscPrice ~= F*sigmaT/sqrt(2*pi) for a
  // small-vol at-the-money option). Away from the money this seed is only
  // roughly right, but that only costs iterations, never correctness: a
  // wayward Halley step falls back to brent below.
  let sigmaT = Math.min(sigmaTHi, Math.max(sigmaTLo, (undiscPrice * Math.sqrt(2 * Math.PI)) / fwd));

  let iterations = 0;
  let converged = false;
  for (; iterations < MAX_HALLEY_ITER; iterations++) {
    const { price: p, vega, vomma } = blackForward(fwd, k, sigmaT, isCallEff);
    if (!(p > 0) || !Number.isFinite(p) || !(vega > 0)) break;

    // Halley's method on g(sigmaT) = ln(price(sigmaT)) - ln(target). Working
    // in log price, not raw price, is what keeps this well-conditioned for
    // an out-of-the-money option, whose price can be many orders of
    // magnitude smaller than at-the-money — see module doc, point 3.
    const g = Math.log(p) - lnTarget;
    const gPrime = vega / p;
    const gDoublePrime = vomma / p - gPrime * gPrime;

    const denom = 2 * gPrime * gPrime - g * gDoublePrime;
    const step =
      Number.isFinite(denom) && Math.abs(denom) > 1e-300
        ? (2 * g * gPrime) / denom // Halley: cubic convergence.
        : g / gPrime; // Newton: degenerates gracefully if vomma misbehaves.

    let next = sigmaT - step;
    if (!Number.isFinite(next) || next <= sigmaTLo || next >= sigmaTHi) {
      // The full Halley/Newton step left the bracket. Try a plain Newton
      // half-step before giving up on this iteration entirely — cheap, and
      // it recovers the common case where only the cubic correction term
      // overshot.
      next = sigmaT - g / gPrime;
      if (!Number.isFinite(next) || next <= sigmaTLo || next >= sigmaTHi) break;
    }

    const settled = Math.abs(g) < 1e-13 || Math.abs(next - sigmaT) < 1e-14 * Math.max(next, sigmaTLo);
    sigmaT = next;
    if (settled) {
      iterations += 1;
      converged = true;
      break;
    }
  }

  let usedFallback = false;
  if (!converged || !(sigmaT > sigmaTLo) || !(sigmaT < sigmaTHi)) {
    usedFallback = true;
    // Bracket on LOG price, not raw price, for the same reason the Halley
    // loop above does: brent's default tolY (1e-4) is an ABSOLUTE price
    // tolerance. For an out-of-the-money target price that is itself only
    // 1e-4 or smaller, an absolute tolerance that size accepts a root with
    // zero significant digits. Matching in log price makes the tolerance
    // meaningful regardless of how small the target price is.
    const f = (x: number) => Math.log(Math.max(blackForward(fwd, k, x, isCallEff).price, 1e-300)) - lnTarget;
    const fLo = f(sigmaTLo);
    const fHi = f(sigmaTHi);
    if (fLo * fHi > 0) return null; // No sign change: the root is outside the bracket.
    try {
      sigmaT = brent(f, sigmaTLo, sigmaTHi, { tolY: 1e-13, tolX: 1e-12, maxIter: 100 }).root;
    } catch {
      return null;
    }
  }

  const vol = sigmaT / sqrtT;
  if (!(vol >= MIN_VOL) || !(vol <= MAX_VOL)) return null;

  if (diag) {
    diag.iterations = iterations;
    diag.usedFallback = usedFallback;
  }
  return vol;
}
