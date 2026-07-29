/**
 * Nelder-Mead derivative-free simplex minimizer.
 *
 * WHY a new optimizer: `../engine/solver.ts` already has `brent`, but Brent
 * finds a ROOT of a one-dimensional function on a bracket. The GARCH(1,1)
 * fit in `./garch.ts` MINIMIZES a two-parameter negative log-likelihood, a
 * different problem in more than one dimension, so Brent cannot serve it.
 * Nelder-Mead needs no gradient (the likelihood is not convenient to
 * differentiate by hand) and is standard for a small, low-dimensional fit
 * like this one.
 *
 * The method walks a simplex of n+1 points through n-dimensional space,
 * replacing its worst point each iteration by reflecting, expanding or
 * contracting toward the centroid of the rest, and shrinking the whole
 * simplex toward its best point when none of those moves improve on the
 * worst point. See Nelder and Mead (1965), "A simplex method for function
 * minimization".
 */

export interface NelderMeadResult {
  x: number[];
  fx: number;
  iterations: number;
  /** True when both the function-value spread and the point spread across
   * the final simplex fell below tolerance. False means the caller got the
   * best point found in `maxIter` iterations, not a certified minimum — the
   * GARCH fit treats a non-converged result as "reject and fall back". */
  converged: boolean;
}

export interface NelderMeadOptions {
  maxIter?: number;
  /** Convergence threshold on the simplex's spatial spread. */
  tolX?: number;
  /** Convergence threshold on the simplex's function-value spread. */
  tolF?: number;
  /** Size of the initial simplex's perturbation away from `x0`, as a
   * fraction of each coordinate (or an absolute step for a zero coordinate). */
  initialStep?: number;
}

// Standard Nelder-Mead reflection, expansion, contraction and shrink
// coefficients (Nelder and Mead 1965).
const ALPHA = 1;
const GAMMA = 2;
const RHO = 0.5;
const SIGMA = 0.5;

export function nelderMead(
  f: (x: number[]) => number,
  x0: number[],
  opts: NelderMeadOptions = {},
): NelderMeadResult {
  const n = x0.length;
  const maxIter = opts.maxIter ?? 200;
  const tolX = opts.tolX ?? 1e-8;
  const tolF = opts.tolF ?? 1e-10;
  const step = opts.initialStep ?? 0.1;

  // Build the initial simplex: x0, plus one point per dimension nudged away
  // from it.
  const simplex: { x: number[]; fx: number }[] = [{ x: x0.slice(), fx: f(x0) }];
  for (let i = 0; i < n; i++) {
    const x = x0.slice();
    x[i] += x[i] !== 0 ? x[i] * step : step;
    simplex.push({ x, fx: f(x) });
  }

  let iterations = 0;
  let converged = false;
  for (; iterations < maxIter; iterations++) {
    simplex.sort((a, b) => a.fx - b.fx);
    const best = simplex[0];
    const worst = simplex[n];
    const secondWorst = simplex[n - 1];

    const fSpread = Math.abs(worst.fx - best.fx);
    let xSpread = 0;
    for (let i = 1; i <= n; i++) {
      let d2 = 0;
      for (let j = 0; j < n; j++) {
        const diff = simplex[i].x[j] - best.x[j];
        d2 += diff * diff;
      }
      xSpread = Math.max(xSpread, Math.sqrt(d2));
    }
    if (fSpread < tolF && xSpread < tolX) {
      converged = true;
      break;
    }

    // Centroid of every point except the worst.
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) centroid[j] += simplex[i].x[j];
    }
    for (let j = 0; j < n; j++) centroid[j] /= n;

    const reflected = centroid.map((c, j) => c + ALPHA * (c - worst.x[j]));
    const fReflected = f(reflected);

    if (fReflected < best.fx) {
      const expanded = centroid.map((c, j) => c + GAMMA * (reflected[j] - c));
      const fExpanded = f(expanded);
      simplex[n] = fExpanded < fReflected ? { x: expanded, fx: fExpanded } : { x: reflected, fx: fReflected };
    } else if (fReflected < secondWorst.fx) {
      simplex[n] = { x: reflected, fx: fReflected };
    } else {
      const contracted = centroid.map((c, j) => c + RHO * (worst.x[j] - c));
      const fContracted = f(contracted);
      if (fContracted < worst.fx) {
        simplex[n] = { x: contracted, fx: fContracted };
      } else {
        // Neither reflection nor contraction improved on the worst point:
        // shrink the whole simplex toward the best point.
        for (let i = 1; i <= n; i++) {
          const x = best.x.map((bx, j) => bx + SIGMA * (simplex[i].x[j] - bx));
          simplex[i] = { x, fx: f(x) };
        }
      }
    }
  }

  simplex.sort((a, b) => a.fx - b.fx);
  return { x: simplex[0].x, fx: simplex[0].fx, iterations, converged };
}
