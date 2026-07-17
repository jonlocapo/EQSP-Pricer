/**
 * Root finding utilities used for reoffer solves (solve-for-coupon,
 * solve-for-barrier, etc).
 */

export interface BrentOptions {
  tolX?: number;
  tolY?: number;
  maxIter?: number;
}

export interface BrentResult {
  root: number;
  iterations: number;
}

const DEFAULT_TOL_X = 1e-6;
const DEFAULT_TOL_Y = 1e-4;
const DEFAULT_MAX_ITER = 60;

/**
 * Brent's method (inverse quadratic interpolation / secant, with bisection
 * fallback) for finding a root of `f` bracketed by [lo, hi].
 */
export function brent(
  f: (x: number) => number,
  lo: number,
  hi: number,
  opts: BrentOptions = {},
): BrentResult {
  const tolX = opts.tolX ?? DEFAULT_TOL_X;
  const tolY = opts.tolY ?? DEFAULT_TOL_Y;
  const maxIter = opts.maxIter ?? DEFAULT_MAX_ITER;

  let a = lo;
  let b = hi;
  let fa = f(a);
  let fb = f(b);

  if (Math.abs(fa) < tolY) return { root: a, iterations: 0 };
  if (Math.abs(fb) < tolY) return { root: b, iterations: 0 };

  if (fa * fb > 0) {
    throw new Error(`brent: no sign change on [${lo}, ${hi}] (f(lo)=${fa}, f(hi)=${fb})`);
  }

  // Ensure |f(a)| >= |f(b)| so b is the best estimate so far.
  if (Math.abs(fa) < Math.abs(fb)) {
    [a, b] = [b, a];
    [fa, fb] = [fb, fa];
  }

  let c = a;
  let fc = fa;
  let mflag = true;
  let d = a; // only meaningful once mflag is false

  let iterations = 0;
  for (; iterations < maxIter; iterations++) {
    if (Math.abs(fb) < tolY || Math.abs(b - a) < tolX) {
      break;
    }

    let s: number;
    if (fa !== fc && fb !== fc) {
      // Inverse quadratic interpolation.
      s =
        (a * fb * fc) / ((fa - fb) * (fa - fc)) +
        (b * fa * fc) / ((fb - fa) * (fb - fc)) +
        (c * fa * fb) / ((fc - fa) * (fc - fb));
    } else {
      // Secant method.
      s = b - fb * ((b - a) / (fb - fa));
    }

    const cond1 = (s - (3 * a + b) / 4) * (s - b) > 0;
    const cond2 = mflag && Math.abs(s - b) >= Math.abs(b - c) / 2;
    const cond3 = !mflag && Math.abs(s - b) >= Math.abs(c - d) / 2;
    const cond4 = mflag && Math.abs(b - c) < tolX;
    const cond5 = !mflag && Math.abs(c - d) < tolX;

    if (cond1 || cond2 || cond3 || cond4 || cond5) {
      // Bisection fallback.
      s = (a + b) / 2;
      mflag = true;
    } else {
      mflag = false;
    }

    const fs = f(s);
    d = c;
    c = b;
    fc = fb;

    if (fa * fs < 0) {
      b = s;
      fb = fs;
    } else {
      a = s;
      fa = fs;
    }

    if (Math.abs(fa) < Math.abs(fb)) {
      [a, b] = [b, a];
      [fa, fb] = [fb, fa];
    }
  }

  return { root: b, iterations };
}

/**
 * Doubles the search interval outward from [lo, hi] toward [hardLo, hardHi]
 * until a sign change is found. Throws if the hard bounds are exhausted
 * without one.
 */
export function expandBracket(
  f: (x: number) => number,
  lo: number,
  hi: number,
  hardLo: number,
  hardHi: number,
): [number, number] {
  let a = lo;
  let b = hi;
  let fa = f(a);
  let fb = f(b);

  if (fa * fb <= 0) return [a, b];

  while (a > hardLo || b < hardHi) {
    const width = b - a;
    const newA = Math.max(hardLo, a - width);
    const newB = Math.min(hardHi, b + width);

    if (newA === a && newB === b) break;

    a = newA;
    b = newB;
    fa = f(a);
    fb = f(b);

    if (fa * fb <= 0) return [a, b];
  }

  throw new Error(
    `expandBracket: no sign change found within hard bounds [${hardLo}, ${hardHi}] (last tried [${a}, ${b}])`,
  );
}
