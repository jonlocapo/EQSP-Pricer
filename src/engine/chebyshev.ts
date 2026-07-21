/**
 * Chebyshev-Lobatto barycentric interpolation, used to build a fast
 * price/greeks surrogate: price the (expensive) MC engine at a handful of
 * Chebyshev nodes across a spot range, then interpolate PV(spot) and
 * differentiate the interpolant ANALYTICALLY for delta/gamma — no
 * bump-and-reprice.
 *
 * All node arrays (nodesX/nodesY) are expected in "k = 0..N" Chebyshev-Lobatto
 * order, i.e. the order produced by chebyshevLobattoNodes/chebyshevLobattoSpotNodes
 * (x_0 = +1 mapped to spotHi, descending to x_N = -1 mapped to spotLo). The
 * barycentric weights below are keyed by that index, not by node value, so
 * callers must preserve this order end to end.
 *
 * Differentiation uses the general barycentric differentiation-matrix
 * formula (Berrut & Trefethen, "Barycentric Lagrange Interpolation", SIAM
 * Review 2004, eq. 9.4):
 *   D(i,j) = (w_j / w_i) / (x_i - x_j),   i != j
 *   D(i,i) = -sum_{j != i} D(i,j)
 * applied directly to the REAL (spot) node positions with the CANONICAL
 * Chebyshev weights w_k = (-1)^k * delta_k. Because barycentric weights are
 * invariant (up to an irrelevant common scale factor) under the affine map
 * from [-1,1] to [spotLo, spotHi], using canonical weights together with
 * real-domain node positions in the (x_i - x_j) denominator automatically
 * folds in the chain-rule factor 2/(spotHi - spotLo) — there is no separate
 * rescaling step to get wrong. Applying D twice gives the second derivative
 * (gamma) directly in real (spot) units.
 */

export interface ChebyshevInterpolant {
  /** Interpolated value at x (need not be a node). */
  eval(x: number): number;
  /** First derivative d/dx of the interpolant, evaluated analytically. */
  derivative(x: number): number;
  /** Second derivative d²/dx² of the interpolant, evaluated analytically. */
  secondDerivative(x: number): number;
}

/**
 * Chebyshev points of the second kind (Chebyshev-Lobatto) on [-1, 1]:
 * x_k = cos(k*pi/N), k = 0..N — N+1 nodes, x_0 = 1 descending to x_N = -1.
 */
export function chebyshevLobattoNodes(N: number): number[] {
  if (N === 0) return [1];
  const nodes = new Array<number>(N + 1);
  for (let k = 0; k <= N; k++) nodes[k] = Math.cos((k * Math.PI) / N);
  return nodes;
}

/** Affine map from canonical [-1, 1] to [lo, hi]. */
export function mapToSpot(x: number, lo: number, hi: number): number {
  return (hi + lo) / 2 + ((hi - lo) / 2) * x;
}

/** Inverse of mapToSpot: real domain [lo, hi] back to canonical [-1, 1]. */
export function mapToCanonical(spot: number, lo: number, hi: number): number {
  return (2 * spot - (hi + lo)) / (hi - lo);
}

/**
 * Chebyshev-Lobatto nodes mapped into [lo, hi], in the same k = 0..N order
 * (nodesX[0] = hi, nodesX[N] = lo).
 */
export function chebyshevLobattoSpotNodes(N: number, lo: number, hi: number): number[] {
  return chebyshevLobattoNodes(N).map((x) => mapToSpot(x, lo, hi));
}

/** Barycentric weights for Chebyshev-Lobatto nodes: w_k = (-1)^k * delta_k,
 * delta_0 = delta_N = 1/2, else 1. Domain-independent (see module doc). */
function barycentricWeights(N: number): number[] {
  const w = new Array<number>(N + 1);
  for (let k = 0; k <= N; k++) {
    const delta = k === 0 || k === N ? 0.5 : 1;
    w[k] = (k % 2 === 0 ? 1 : -1) * delta;
  }
  return w;
}

/** Second-form barycentric interpolation at x, given nodes/values/weights
 * (all same length, same order). Falls back to the exact nodal value when x
 * coincides with a node, avoiding 0/0. */
function barycentricEval(x: number, nodesX: number[], nodesY: number[], weights: number[]): number {
  for (let k = 0; k < nodesX.length; k++) {
    const d = x - nodesX[k];
    if (Math.abs(d) < 1e-12) return nodesY[k];
  }
  let num = 0;
  let den = 0;
  for (let k = 0; k < nodesX.length; k++) {
    const t = weights[k] / (x - nodesX[k]);
    num += t * nodesY[k];
    den += t;
  }
  return num / den;
}

/** Berrut-Trefethen barycentric differentiation matrix for arbitrary node
 * positions `nodesX`, given their (canonical) barycentric weights. */
function diffMatrix(nodesX: number[], weights: number[]): number[][] {
  const n = nodesX.length;
  const D: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    let rowSum = 0;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const dij = (weights[j] / weights[i]) / (nodesX[i] - nodesX[j]);
      D[i][j] = dij;
      rowSum += dij;
    }
    D[i][i] = -rowSum;
  }
  return D;
}

function matVec(D: number[][], y: number[]): number[] {
  const n = y.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += D[i][j] * y[j];
    out[i] = s;
  }
  return out;
}

/**
 * Builds a barycentric Chebyshev interpolant from node positions/values.
 * `nodesX`/`nodesY` must be in Chebyshev-Lobatto k=0..N order (see module
 * doc) — typically `nodesX` comes from `chebyshevLobattoSpotNodes`.
 *
 * Returns eval/derivative/secondDerivative, all evaluated analytically by
 * differentiating the interpolating polynomial (no bump-and-reprice).
 */
export function buildChebyshevInterpolant(nodesX: number[], nodesY: number[]): ChebyshevInterpolant {
  if (nodesX.length !== nodesY.length) {
    throw new Error('buildChebyshevInterpolant: nodesX and nodesY must have the same length');
  }
  if (nodesX.length < 2) {
    throw new Error('buildChebyshevInterpolant: need at least 2 nodes');
  }
  const N = nodesX.length - 1;
  const w = barycentricWeights(N);
  const D = diffMatrix(nodesX, w);
  const dY = matVec(D, nodesY);
  const d2Y = matVec(D, dY);

  return {
    eval: (x) => barycentricEval(x, nodesX, nodesY, w),
    derivative: (x) => barycentricEval(x, nodesX, dY, w),
    secondDerivative: (x) => barycentricEval(x, nodesX, d2Y, w),
  };
}
