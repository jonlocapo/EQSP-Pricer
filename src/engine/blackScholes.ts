/**
 * Closed-form Black-Scholes benchmarks used by tests and the sanity panel.
 */

/** Standard normal CDF via the Abramowitz-Stegun 7.1.26 approximation (|err| < 1e-7). */
export function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
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
