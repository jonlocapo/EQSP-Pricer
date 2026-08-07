/**
 * Test-only reference maths for two-asset worst-of pricing, from PREREQUISITES.
 * Not part of the app: this is the "known right answer" to check the basket
 * Monte Carlo against, exactly as Black-Scholes and Reiner-Rubinstein sit in
 * the test folder for the single-asset engine.
 *
 * Three pieces, built on top of the engine's own `normCdf` (which is accurate
 * to ~1e-13):
 *
 *  - `normCdf2(a, b, rho)`: the bivariate standard-normal CDF, via Drezner's
 *    single integral. The doc asks for a two-variable version of erfc; normCdf
 *    IS the one-variable CDF built on erfc, and Drezner (1978) expresses
 *    Phi_2 in terms of it plus one one-dimensional integral.
 *
 *  - `worstOfDigitalProb`: P(min(S1,S2) > K), the two-asset worst-of DIGITAL,
 *    which is a pure bivariate-normal tail probability. This is the cheapest
 *    check of the RNG + correlation, with no payoff machinery at all.
 *
 *  - `stulzCallOnMin`: the Stulz (1982) closed form for a call on the minimum
 *    of two assets, derived from first principles (change of numeraire), so a
 *    real payoff has a formula to be measured against. It is cross-checked in
 *    its test against an independent 2D quadrature of the exact expectation,
 *    so a derivation slip in either direction is caught before either is
 *    trusted as a reference.
 */
import { normCdf } from '../src/engine/blackScholes';

/**
 * Gauss-Legendre nodes and weights on [-1, 1] for n-point quadrature.
 * Computed by Newton iteration on the Legendre polynomial P_n, with the
 * asymptotic initial guess x_k = cos(pi(k-0.25)/(n+0.5)); three or four
 * iterations converge to machine precision. Weights from the standard
 * w_k = 2 / ((1 - x_k^2) P_n'(x_k)^2).
 */
export function gaussLegendre(n: number): { x: number[]; w: number[] } {
  const x: number[] = new Array(n);
  const w: number[] = new Array(n);
  for (let k = 0; k < n; k++) {
    let xk = Math.cos((Math.PI * (k + 0.75)) / (n + 0.5));
    for (let iter = 0; iter < 12; iter++) {
      // P0, P1 via the recurrence, then P_n and P_n'.
      let p0 = 1;
      let p1 = xk;
      for (let m = 1; m < n; m++) {
        const p2 = ((2 * m + 1) * xk * p1 - m * p0) / (m + 1);
        p0 = p1;
        p1 = p2;
      }
      const dp = (n * (xk * p1 - p0)) / (xk * xk - 1);
      const step = p1 / dp;
      xk -= step;
      if (Math.abs(step) < 1e-15) break;
    }
    x[k] = xk;
    // Recompute P_n at the converged node for the weight.
    let p0 = 1;
    let p1 = xk;
    for (let m = 1; m < n; m++) {
      const p2 = ((2 * m + 1) * xk * p1 - m * p0) / (m + 1);
      p0 = p1;
      p1 = p2;
    }
    const dp = (n * (xk * p1 - p0)) / (xk * xk - 1);
    w[k] = 2 / ((1 - xk * xk) * dp * dp);
  }
  return { x, w };
}

/** Integral of f over [0, u] by mapping to [-1, 1] and applying Gauss-Legendre. */
export function integrateGL(f: (t: number) => number, u: number, n = 80): number {
  const { x, w } = gaussLegendre(n);
  const h = u / 2;
  let sum = 0;
  for (let k = 0; k < n; k++) {
    sum += w[k] * f(h * (x[k] + 1));
  }
  return h * sum;
}

/**
 * Bivariate standard-normal CDF:
 *
 *   Phi_2(a, b; rho) = P(Z1 <= a, Z2 <= b),  (Z1, Z2) ~ N(0, 0, 1, 1, rho).
 *
 * Computed as the CONDITIONAL integral, which is unconditionally stable (unlike
 * Drezner's form, which subtracts two large terms for deep-OTM/ITM arguments):
 *
 *   Phi_2(a,b;rho) = integral_{-inf}^a phi(x) Phi((b - rho x)/sqrt(1-rho^2)) dx
 *
 * the integrand is a genuine density times a bounded CDF, so there is never
 * cancellation. Gauss-Legendre on [-8, a] (clamped: |a| >= 8 collapses to the
 * marginal or zero) reaches double-precision accuracy.
 *
 * Edge cases handled exactly:
 *  - rho = 1  -> Phi(min(a, b))            (perfect correlation, one variable
 *    dominates the other, the smaller threshold binds)
 *  - rho = -1 -> max(0, Phi(a) + Phi(b) - 1)
 *  - a or b = +/-Infinity collapse to the marginal / zero.
 * For |rho| within 1e-9 of a bound the limit formula is used.
 */
export function normCdf2(a: number, b: number, rho: number): number {
  if (a === Infinity) return normCdf(b);
  if (b === Infinity) return normCdf(a);
  if (a === -Infinity || b === -Infinity) return 0;
  if (rho >= 1 - 1e-9) return Math.min(normCdf(a), normCdf(b));
  if (rho <= -1 + 1e-9) return Math.max(0, normCdf(a) + normCdf(b) - 1);
  if (a >= 8) return normCdf(b);
  if (b >= 8) return normCdf(a);
  if (a <= -8 || b <= -8) return 0;

  const denom = Math.sqrt(1 - rho * rho);
  const { x, w } = gaussLegendre(96);
  const lo = -8;
  const h = (a - lo) / 2;
  let sum = 0;
  for (let k = 0; k < 96; k++) {
    const xk = h * (x[k] + 1) + lo;
    sum += w[k] * normCdf((b - rho * xk) / denom) * Math.exp(-0.5 * xk * xk);
  }
  return (h * sum) / Math.sqrt(2 * Math.PI);
}

/**
 * P(min(S1(T), S2(T)) > K): the two-asset worst-of DIGITAL.
 *
 * Each log-return is normal with log-drift nu_j T = (r - q_j - sigma_j^2/2) T
 * and standard deviation sigma_j sqrt(T); the pair is correlated with rho.
 * The event {S1 > K, S2 > K} is a rectangle in the standardized space, so:
 *
 *   P = 1 - Phi(a1) - Phi(a2) + Phi_2(a1, a2; rho),
 *   a_j = (ln(K/S_j(0)) - nu_j T) / (sigma_j sqrt(T)).
 *
 * This is the A2 check: a closed form needing only the RNG and the correlation,
 * with no payoff or discounting machinery.
 */
export function worstOfDigitalProb(
  s1: number,
  s2: number,
  sigma1: number,
  sigma2: number,
  rho: number,
  r: number,
  q1: number,
  q2: number,
  k: number,
  t: number,
): number {
  const nu1 = (r - q1 - 0.5 * sigma1 * sigma1) * t;
  const nu2 = (r - q2 - 0.5 * sigma2 * sigma2) * t;
  const a1 = (Math.log(k / s1) - nu1) / (sigma1 * Math.sqrt(t));
  const a2 = (Math.log(k / s2) - nu2) / (sigma2 * Math.sqrt(t));
  return 1 - normCdf(a1) - normCdf(a2) + normCdf2(a1, a2, rho);
}

/**
 * Stulz (1982), "Options on the Minimum or the Maximum of Two Risky Assets":
 * the fair value of a European call on min(S1, S2), paid in cash, derived
 * here from first principles rather than copied, so the test file owns the
 * argument structure.
 *
 * Decompose the payoff by which asset is the minimum:
 *
 *   (min(S1,S2) - K)+ = (S1 - K) 1{S1 < S2, S1 > K}
 *                     + (S2 - K) 1{S2 <= S1, S2 > K}.
 *
 * Each term splits into an asset-or-nothing part and a digital part:
 *
 *   E[(S_i - K) 1{S_i < S_j, S_i > K}]
 *     = S_i(0) e^{-q_i T} P^{Q^i}(S_i < S_j, S_i > K)   (numeraire S_i)
 *       - K e^{-r T} P^{Q}(S_i < S_j, S_i > K).
 *
 * The wedge event {S_i > K, S_i < S_j} reduces to a half-plane in a single
 * bivariate-normal pair. With Z = (sigma1 W1 - sigma2 W2)/Sigma, Sigma^2 =
 * sigma1^2 + sigma2^2 - 2 sigma1 sigma2 rho, Z ~ N(0,1) and corr(W_i, Z) =
 * rho_i = (sigma_i - sigma_j rho)/Sigma. Writing a = (ln(K/S_i(0)) - mu_i T)/
 * (sigma_i sqrt(T)) and z = (mu_j T - mu_i T + ln(S_j(0)/S_i(0)))/(Sigma sqrt T)
 * with mu_j T the log-drift of the OTHER asset under the same measure:
 *
 *   P(S_i > K, S_i < S_j) = P(W_i > a, Z < z) = Phi(z) - Phi_2(a, z; rho_i).
 *
 * The measure changes for the asset-or-nothing parts (Girsanov):
 *   Q:      mu_i T = (r - q_i - sigma_i^2/2) T
 *   Q^i:    mu_i T = (r - q_i + sigma_i^2/2) T,
 *           mu_j T = (r - q_j + rho sigma_i sigma_j - sigma_j^2/2) T.
 * Correlation is unchanged by the measure change.
 *
 * At |rho| = 1 the assets share ONE Brownian driver, so Sigma = 0 and the
 * wedge formula degenerates; the payoff is then a one-dimensional function of
 * a single standard normal and is integrated directly (`callOnMinOneFactor`).
 */
export function stulzCallOnMin(
  s1: number,
  s2: number,
  sigma1: number,
  sigma2: number,
  rho: number,
  r: number,
  q1: number,
  q2: number,
  k: number,
  t: number,
): number {
  if (Math.abs(rho) >= 1 - 1e-12) {
    return callOnMinOneFactor(s1, s2, sigma1, sigma2, rho, r, q1, q2, k, t);
  }
  const sqrtT = Math.sqrt(t);
  const Sigma = Math.sqrt(sigma1 * sigma1 + sigma2 * sigma2 - 2 * sigma1 * sigma2 * rho);
  const rho1 = (sigma1 - sigma2 * rho) / Sigma;
  const rho2 = (sigma2 - sigma1 * rho) / Sigma;

  /** P^{measure}(S_i > K, S_i < S_j), with muIT and muJT the log-drifts of the
   * two assets under that measure. Si0/Sj0 are the INITIAL prices of the
   * conditioning asset (i) and the other one (j). */
  const wedge = (
    si0: number,
    sj0: number,
    muIT: number,
    muJT: number,
    sigmaI: number,
    rhoI: number,
  ): number => {
    const a = (Math.log(k / si0) - muIT) / (sigmaI * sqrtT);
    const z = (muJT - muIT + Math.log(sj0 / si0)) / (Sigma * sqrtT);
    return normCdf(z) - normCdf2(a, z, rhoI);
  };

  // Measure Q (money market): both assets drift at their own (r - q).
  const mu1Q = (r - q1 - 0.5 * sigma1 * sigma1) * t;
  const mu2Q = (r - q2 - 0.5 * sigma2 * sigma2) * t;
  const pQ1 = wedge(s1, s2, mu1Q, mu2Q, sigma1, rho1);
  const pQ2 = wedge(s2, s1, mu2Q, mu1Q, sigma2, rho2);

  // Measure Q^1 (numeraire S1).
  const mu1Q1 = (r - q1 + 0.5 * sigma1 * sigma1) * t;
  const mu2Q1 = (r - q2 + rho * sigma1 * sigma2 - 0.5 * sigma2 * sigma2) * t;
  const pQ1Num = wedge(s1, s2, mu1Q1, mu2Q1, sigma1, rho1);

  // Measure Q^2 (numeraire S2).
  const mu2Q2 = (r - q2 + 0.5 * sigma2 * sigma2) * t;
  const mu1Q2 = (r - q1 + rho * sigma1 * sigma2 - 0.5 * sigma1 * sigma1) * t;
  const pQ2Num = wedge(s2, s1, mu2Q2, mu1Q2, sigma2, rho2);

  const df = Math.exp(-r * t);
  return s1 * Math.exp(-q1 * t) * pQ1Num + s2 * Math.exp(-q2 * t) * pQ2Num - k * df * (pQ1 + pQ2);
}

/** The |rho| = 1 limit of the call on min(S1, S2): both assets are driven by
 * one Brownian W, so the payoff is a function of a single standard normal.
 * The integration domain is split at every point where the payoff's piecewise
 * definition changes — where min(S1, S2) = K (S1 = K or S2 = K) and where the
 * minimum switches between the assets (S1 = S2) — so each segment is smooth
 * and Gauss-Legendre converges to machine precision. At identical inputs this
 * reproduces the single-asset Black-Scholes call. */
function callOnMinOneFactor(
  s1: number,
  s2: number,
  sigma1: number,
  sigma2: number,
  rho: number,
  r: number,
  q1: number,
  q2: number,
  k: number,
  t: number,
): number {
  const sqrtT = Math.sqrt(t);
  const nu1 = (r - q1 - 0.5 * sigma1 * sigma1) * t;
  const nu2 = (r - q2 - 0.5 * sigma2 * sigma2) * t;
  const L = 8;
  const knots = [-L, L];
  knots.push((Math.log(k / s1) - nu1) / (sigma1 * sqrtT));
  knots.push((Math.log(k / s2) - nu2) / (sigma2 * sqrtT));
  const crossing = sigma1 - rho * sigma2;
  if (Math.abs(crossing) > 1e-12) knots.push((nu2 - nu1) / (crossing * sqrtT));
  knots.sort((a, b) => a - b);
  const dedup = knots.filter((v, i) => i === 0 || v > knots[i - 1] + 1e-9);

  const payoffAt = (u: number): number => {
    const s1t = s1 * Math.exp(nu1 + sigma1 * sqrtT * u);
    const s2t = s2 * Math.exp(nu2 + rho * sigma2 * sqrtT * u);
    return Math.max(0, Math.min(s1t, s2t) - k);
  };

  const { x, w } = gaussLegendre(48);
  const df = Math.exp(-r * t);
  let total = 0;
  for (let seg = 0; seg < dedup.length - 1; seg++) {
    const a = Math.max(-L, dedup[seg]);
    const b = Math.min(L, dedup[seg + 1]);
    if (b - a < 1e-12) continue;
    const h = (b - a) / 2;
    const mid = (a + b) / 2;
    // On this segment the piecewise payoff is smooth; sample it at the segment
    // midpoint only to pick which asset is the minimum is unnecessary — we just
    // evaluate the full piecewise payoff at the quadrature nodes, and since no
    // knot lies strictly inside the segment it is smooth there.
    let segSum = 0;
    for (let i = 0; i < 48; i++) {
      const u = mid + h * x[i];
      segSum += w[i] * payoffAt(u) * Math.exp(-0.5 * u * u);
    }
    total += h * segSum;
  }
  return (df * total) / Math.sqrt(2 * Math.PI);
}

/**
 * Independent reference for the call on min(S1, S2): a direct 2D Gauss-Legendre
 * quadrature of the exact expectation in the standardized-log space,
 *
 *   e^{-rT} integral integral (min(S1,S2) - K)+ phi(w1) phi(w3) dw1 dw3
 *
 * over a box of +/-8 standard deviations (mass outside is < 1e-15). This is
 * the payoff's definition, nothing more, so it shares no derivation with
 * `stulzCallOnMin` and is a genuine second witness. The payoff kink
 * (min = K along a diagonal) slows the convergence to a small polynomial rate,
 * so 400 nodes per axis are used, which the A3 test validates against Stulz to
 * ~1e-6.
 */
export function quadratureCallOnMin(
  s1: number,
  s2: number,
  sigma1: number,
  sigma2: number,
  rho: number,
  r: number,
  q1: number,
  q2: number,
  k: number,
  t: number,
): number {
  const N = 700;
  const { x, w } = gaussLegendre(N);
  const L = 8;
  const nu1 = (r - q1 - 0.5 * sigma1 * sigma1) * t;
  const nu2 = (r - q2 - 0.5 * sigma2 * sigma2) * t;
  const sT1 = sigma1 * Math.sqrt(t);
  const sT2 = sigma2 * Math.sqrt(t);
  const ch = Math.sqrt(1 - rho * rho);
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const z1 = L * x[i];
    const s1t = s1 * Math.exp(nu1 + sT1 * z1);
    for (let j = 0; j < N; j++) {
      const z2 = L * x[j];
      const s2t = s2 * Math.exp(nu2 + sT2 * (rho * z1 + ch * z2));
      const payoff = Math.max(0, Math.min(s1t, s2t) - k);
      const dens = Math.exp(-0.5 * (z1 * z1 + z2 * z2));
      sum += w[i] * w[j] * payoff * dens;
    }
  }
  // Both dimensions map [-1,1] -> [-L,L] (jacobian L each); phi(w1)phi(w3)
  // carries one 1/(2 pi).
  return (L * L * Math.exp(-r * t) * sum) / (2 * Math.PI);
}
