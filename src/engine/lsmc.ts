import type { MarketData } from '../model/market';
import { makeDf } from './discount';
import { PathBatchGenerator } from './gbm';
import type { CashflowExtractor, PathCashflows, PricingGrid } from './payoffs/types';

export interface LsmcOptions {
  numPaths: number;
  seed: number;
  nSteps: number;
  s0: number;
  market: MarketData;
  grid: PricingGrid;
  cashflows: CashflowExtractor;
  /** Cost (% of notional) the issuer pays to call at the given 1-based
   * call-observation period. Includes accrued/AC coupon; supersedes any
   * base cashflow scheduled at that same date. */
  redemptionCostPct: (period: number) => number;
  /** Grid indices of call observation dates, ascending. */
  callObs: number[];
  /** First 1-based call-observation period the issuer may exercise at. */
  callFromPeriod: number;
  dtYears: number;
}

export interface LsmcResult {
  pvPct: number;
  stderrPct: number;
  callProb: number[];
  expectedLifeYears: number;
}

/** A path's remaining realized cashflow stream, ascending by grid index. */
type CfEntry = { idx: number; amt: number };

const BASIS_DIM = 3;

function basisOf(sOverS0: number): [number, number, number] {
  return [1, sOverS0, sOverS0 * sOverS0];
}

/** Ordinary least squares fit of `y` on the 3-term basis {1, x, x^2}. */
function fitQuadratic(xs: Float64Array, ys: Float64Array): [number, number, number] {
  const n = xs.length;
  const ata = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const atb = [0, 0, 0];

  for (let i = 0; i < n; i++) {
    const b = basisOf(xs[i]);
    const y = ys[i];
    for (let r = 0; r < BASIS_DIM; r++) {
      atb[r] += b[r] * y;
      for (let c = 0; c < BASIS_DIM; c++) {
        ata[r][c] += b[r] * b[c];
      }
    }
  }

  return solve3x3(ata, atb);
}

/** Solves a 3x3 linear system via Gaussian elimination with partial pivoting. */
function solve3x3(a: number[][], b: number[]): [number, number, number] {
  const m = [a[0].slice(), a[1].slice(), a[2].slice()];
  const rhs = b.slice();

  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (pivot !== col) {
      [m[col], m[pivot]] = [m[pivot], m[col]];
      [rhs[col], rhs[pivot]] = [rhs[pivot], rhs[col]];
    }
    const pivotVal = m[col][col];
    if (Math.abs(pivotVal) < 1e-14) continue; // degenerate; leave row as-is
    for (let r = col + 1; r < 3; r++) {
      const factor = m[r][col] / pivotVal;
      for (let c = col; c < 3; c++) m[r][c] -= factor * m[col][c];
      rhs[r] -= factor * rhs[col];
    }
  }

  const x = [0, 0, 0];
  for (let row = 2; row >= 0; row--) {
    let sum = rhs[row];
    for (let c = row + 1; c < 3; c++) sum -= m[row][c] * x[c];
    x[row] = Math.abs(m[row][row]) < 1e-14 ? 0 : sum / m[row][row];
  }
  return [x[0], x[1], x[2]];
}

function evalQuadratic(coeffs: [number, number, number], x: number): number {
  const [c0, c1, c2] = coeffs;
  return c0 + c1 * x + c2 * x * x;
}

/**
 * Discounted-to-tRef value of cashflow entries with idx > fromIdx — i.e. the
 * value of the note strictly *after* a call date. Any flow scheduled exactly
 * at the call date (e.g. the periodic coupon accrued for the just-completed
 * period) is paid regardless of the call decision, so it is excluded from
 * this "continuing to hold" comparison and added back separately by the
 * caller.
 */
function valueFrom(entries: CfEntry[], fromIdx: number, df: (t: number) => number, dtYears: number): number {
  let pv = 0;
  for (const e of entries) {
    if (e.idx > fromIdx) pv += e.amt * df(e.idx * dtYears);
  }
  const dfRef = df(fromIdx * dtYears);
  return dfRef > 0 ? pv / dfRef : 0;
}

/**
 * Longstaff-Schwartz pricing of an issuer-callable note. The issuer calls to
 * MINIMIZE holder value: it exercises at date j whenever the redemption cost
 * is cheaper than the fitted continuation value of the note.
 */
export function priceIssuerCallable(opts: LsmcOptions): LsmcResult {
  const { numPaths, seed, nSteps, s0, market, cashflows, redemptionCostPct, callObs, callFromPeriod, dtYears } =
    opts;

  const df = makeDf(market.rate);
  const callablePeriods = callObs
    .map((gridIdx, i) => ({ period: i + 1, gridIdx }))
    .filter((c) => c.period >= callFromPeriod);

  // ---- Pass 1: fit regression coefficients via backward induction. -------
  const coeffsByPeriod = new Map<number, [number, number, number]>();

  if (callablePeriods.length > 0) {
    const gen1 = new PathBatchGenerator(seed, nSteps, s0, market, dtYears);
    const pathFutureCf: CfEntry[][] = [];
    const spotsAtCall: Float64Array[] = callablePeriods.map(() => new Float64Array(numPaths));

    for (let p = 0; p < numPaths; p++) {
      const spots = gen1.nextSingle();
      const cf = cashflows(spots);
      const entries: CfEntry[] = cf.gridIndices.map((idx, i) => ({ idx, amt: cf.amountsPct[i] }));
      pathFutureCf.push(entries);
      for (let c = 0; c < callablePeriods.length; c++) {
        spotsAtCall[c][p] = spots[callablePeriods[c].gridIdx];
      }
    }

    for (let c = callablePeriods.length - 1; c >= 0; c--) {
      const { period, gridIdx } = callablePeriods[c];
      const contValues = new Float64Array(numPaths);
      const xs = new Float64Array(numPaths);
      for (let p = 0; p < numPaths; p++) {
        contValues[p] = valueFrom(pathFutureCf[p], gridIdx, df, dtYears);
        xs[p] = spotsAtCall[c][p] / s0;
      }
      const coeffs = fitQuadratic(xs, contValues);
      coeffsByPeriod.set(period, coeffs);

      const cost = redemptionCostPct(period);
      for (let p = 0; p < numPaths; p++) {
        const fitted = evalQuadratic(coeffs, xs[p]);
        if (cost < fitted) {
          // Flows at or before the call date are paid regardless (already
          // accrued); everything strictly after is replaced by the
          // redemption cost paid at the call date.
          pathFutureCf[p] = pathFutureCf[p]
            .filter((e) => e.idx <= gridIdx)
            .concat([{ idx: gridIdx, amt: cost }]);
        }
      }
    }
  }

  // ---- Pass 2: fresh paths, apply the fitted rule forward in time. -------
  const gen2 = new PathBatchGenerator(seed + 1, nSteps, s0, market, dtYears);
  let sum = 0;
  let sumSq = 0;
  const callCounts = new Array<number>(callablePeriods.length).fill(0);
  let lifeYearsSum = 0;

  for (let p = 0; p < numPaths; p++) {
    const spots = gen2.nextSingle();
    const cf = cashflows(spots);

    let pv = 0;
    let called = false;
    let lifeYears = opts.grid.tenorYears;

    for (let c = 0; c < callablePeriods.length; c++) {
      const { period, gridIdx } = callablePeriods[c];
      const coeffs = coeffsByPeriod.get(period);
      if (!coeffs) continue;
      const x = spots[gridIdx] / s0;
      const fitted = evalQuadratic(coeffs, x);
      const cost = redemptionCostPct(period);
      if (cost < fitted) {
        for (let i = 0; i < cf.gridIndices.length; i++) {
          if (cf.gridIndices[i] < gridIdx) pv += cf.amountsPct[i] * df(cf.gridIndices[i] * dtYears);
        }
        pv += cost * df(gridIdx * dtYears);
        callCounts[c] += 1;
        lifeYears = gridIdx * dtYears;
        called = true;
        break;
      }
    }

    if (!called) {
      for (let i = 0; i < cf.gridIndices.length; i++) {
        pv += cf.amountsPct[i] * df(cf.gridIndices[i] * dtYears);
      }
    }

    sum += pv;
    sumSq += pv * pv;
    lifeYearsSum += lifeYears;
  }

  const mean = sum / numPaths;
  const variance = numPaths > 1 ? Math.max(0, (sumSq / numPaths - mean * mean) * (numPaths / (numPaths - 1))) : 0;
  const stderrPct = Math.sqrt(variance / numPaths);
  const callProb = callCounts.map((c) => c / numPaths);

  return {
    pvPct: mean,
    stderrPct,
    callProb,
    expectedLifeYears: lifeYearsSum / numPaths,
  };
}

// Re-exported for callers that need the shape without importing payoffs/types directly.
export type { PathCashflows };
