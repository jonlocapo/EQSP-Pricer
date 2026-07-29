/**
 * Closed-form Black-Scholes benchmarks used by tests, the sanity panel, and
 * (via ./impliedVol) the implied-vol inversion.
 */

/**
 * erfc(x) for x >= 0, via the non-alternating (Kummer) series for erf. Every
 * term is positive, x * exp(-x^2) * sum (2x^2)^n / (2n+1)!!, so there is no
 * cancellation the way there is in the classic alternating Taylor series for
 * erf. Safe and fast for the moderate range this is used on, where erf(x)
 * itself is not yet so close to 1 that "1 - erf(x)" would lose precision.
 */
function erfSeries(x: number): number {
  let sum = 1;
  let term = 1;
  const x2 = x * x;
  for (let n = 1; n < 400; n++) {
    term *= (2 * x2) / (2 * n + 1);
    sum += term;
    if (term < 1e-18 * sum) break;
  }
  return ((2 / Math.sqrt(Math.PI)) * x * Math.exp(-x2)) * sum;
}

/**
 * erfc(x) for x >= 0, via Lentz's algorithm on the continued fraction
 * erfc(x) = exp(-x^2)/sqrt(pi) * 1/(x + a1/(x + a2/(x + ...))), a_n = n/2
 * (Abramowitz-Stegun 7.1.14). This computes the small tail value directly —
 * it never forms "1 - erf(x)" — so it stays accurate however small erfc(x)
 * gets, which is exactly the deep-wing case a subtraction would destroy.
 * Converges quickly once x is not tiny; the small-x range is covered by
 * `erfSeries` instead (see the crossover in erfcHi below).
 */
function erfcContinuedFraction(x: number): number {
  const tiny = 1e-300;
  let f = x === 0 ? tiny : x;
  let c = f;
  let d = 0;
  for (let n = 1; n <= 200; n++) {
    const an = n / 2;
    d = x + an * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = x + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = c * d;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-17) break;
  }
  return (Math.exp(-x * x) / Math.sqrt(Math.PI)) * (1 / f);
}

/**
 * Below this, `erfSeries` is both accurate and cheap; the continued fraction
 * converges too slowly there to be worth using. Above it, the series is
 * still accurate, but forming erfc as "1 - erf" starts throwing away digits
 * as erf approaches 1, so the continued fraction takes over instead: it
 * computes the (by then small) erfc value directly, with no subtraction.
 */
const ERFC_CROSSOVER = 1;

/** erfc(x) for x >= 0, accurate to roughly 1e-13 relative error even deep
 * in the tail (measured against 30-digit mpmath ground truth out to x=30 —
 * see tests/blackScholes.test.ts), instead of the ~1e-7 ABSOLUTE error the
 * old Abramowitz-Stegun 7.1.26 fit carried. An absolute error of 1e-7 is
 * fine near the money, where N(x) itself is order 1, but it swamps a deep
 * out-of-the-money value that is itself 1e-9 or smaller — exactly the
 * region the volatility skew this codebase cares about lives in. */
function erfcHi(x: number): number {
  return x < ERFC_CROSSOVER ? 1 - erfSeries(x) : erfcContinuedFraction(x);
}

/**
 * Standard normal CDF, double-precision accurate (see erfcHi's doc). Built
 * from erfc, not erf: for x < 0 the tail is 0.5 * erfc(-x/sqrt2), computed
 * directly by `erfcHi` with no "1 - (something near 1)" subtraction, so the
 * deep left tail — where a knock-in barrier's skew-relevant probability
 * lives — keeps its relative precision instead of being flushed to noise.
 */
export function normCdf(x: number): number {
  const u = Math.abs(x) / Math.SQRT2;
  const tail = 0.5 * erfcHi(u);
  return x >= 0 ? 1 - tail : tail;
}

function d1d2(s: number, k: number, t: number, vol: number, r: number, q: number): [number, number] {
  const d1 = (Math.log(s / k) + (r - q + 0.5 * vol * vol) * t) / (vol * Math.sqrt(t));
  const d2 = d1 - vol * Math.sqrt(t);
  return [d1, d2];
}

export function bsCall(s: number, k: number, t: number, vol: number, r: number, q: number): number {
  const [d1, d2] = d1d2(s, k, t, vol, r, q);
  return s * Math.exp(-q * t) * normCdf(d1) - k * Math.exp(-r * t) * normCdf(d2);
}

export function bsPut(s: number, k: number, t: number, vol: number, r: number, q: number): number {
  const [d1, d2] = d1d2(s, k, t, vol, r, q);
  return k * Math.exp(-r * t) * normCdf(-d2) - s * Math.exp(-q * t) * normCdf(-d1);
}

/**
 * Down-and-in put, continuous monitoring (Reiner-Rubinstein 1991). Requires
 * barrier < k and barrier < s (down-and-in with barrier below both strike
 * and spot, the standard structured-product case: DIP = B - C + D).
 */
export function downAndInPut(
  s: number,
  k: number,
  barrier: number,
  t: number,
  vol: number,
  r: number,
  q: number,
): number {
  const b = r - q;
  const mu = (b - 0.5 * vol * vol) / (vol * vol);
  const sqrtT = Math.sqrt(t);
  const volSqrtT = vol * sqrtT;

  const exQ = Math.exp(-q * t);
  const exR = Math.exp(-r * t);
  const hOverS = barrier / s;

  const x2 = Math.log(s / barrier) / volSqrtT + (1 + mu) * volSqrtT;
  const y1 = Math.log((barrier * barrier) / (s * k)) / volSqrtT + (1 + mu) * volSqrtT;
  const y2 = Math.log(barrier / s) / volSqrtT + (1 + mu) * volSqrtT;

  const termB = -s * exQ * normCdf(-x2) + k * exR * normCdf(-x2 + volSqrtT);
  const termC =
    -s * exQ * Math.pow(hOverS, 2 * (mu + 1)) * normCdf(y1) +
    k * exR * Math.pow(hOverS, 2 * mu) * normCdf(y1 - volSqrtT);
  const termD =
    -s * exQ * Math.pow(hOverS, 2 * (mu + 1)) * normCdf(y2) +
    k * exR * Math.pow(hOverS, 2 * mu) * normCdf(y2 - volSqrtT);

  return termB - termC + termD;
}
