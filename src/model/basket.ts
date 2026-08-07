/**
 * Pure assembly helpers for the worst-of basket UI layer. This file builds
 * the values the pricing request needs (`spec.underlyings`,
 * `MarketData.basket`) from the per-leg inputs the panels collect. It owns
 * no engine or worker logic; it only shapes data before it reaches them.
 */
import type { Underlying } from './product';
import type { BasketAsset, BasketParams } from './market';
import { repairCorrelation } from './correlation';

/** One leg's inputs, in `spec.underlyings` order. Leg 0 is always the
 * existing single-underlying panel: its name, vol and dividend yield stay
 * the ones the app already tracks, so a one-leg trade is untouched. */
export interface BasketLegInput {
  name: string;
  vol: number;
  divYield: number;
}

export interface BuiltBasket {
  /** `spec.underlyings`, in the same order as `legs`. */
  underlyings: Underlying[];
  /** `MarketData.basket`. Undefined for fewer than two legs, so the engine
   * takes its single-underlying branch and stays bit-identical to today. */
  basket: BasketParams | undefined;
  /** True when `repairCorrelation` changed the matrix by more than a
   * rounding amount, so the panel can show a quiet "adjusted" note. */
  correlationAdjusted: boolean;
}

/** Departure between a raw and repaired correlation entry small enough to
 * call "the same matrix", so the UI does not flag float noise as a repair. */
const MATERIAL_TOL = 1e-6;

function matricesClose(a: number[][], b: number[][]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!a[i] || a[i].length !== b[i].length) return false;
    for (let j = 0; j < a[i].length; j++) {
      const av = a[i][j];
      if (!Number.isFinite(av) || Math.abs(av - b[i][j]) > MATERIAL_TOL) return false;
    }
  }
  return true;
}

/**
 * Assembles the ordered underlyings list and, when there are two or more
 * legs, the basket market params. `rawCorrelation` is the matrix exactly as
 * the user typed it: it may not be PSD, and `repairCorrelation` is what
 * makes it a valid correlation matrix for the engine (see
 * model/correlation.ts for why repair, not rejection, is correct here).
 */
export function buildBasket(legs: BasketLegInput[], rawCorrelation: number[][]): BuiltBasket {
  const underlyings = legs.map((l) => ({ name: l.name }));
  if (legs.length < 2) {
    return { underlyings, basket: undefined, correlationAdjusted: false };
  }
  const repaired = repairCorrelation(rawCorrelation);
  const assets: BasketAsset[] = legs.map((l) => ({ vol: l.vol, divYield: l.divYield }));
  return {
    underlyings,
    basket: { assets, correlation: repaired },
    correlationAdjusted: !matricesClose(rawCorrelation, repaired),
  };
}

/** Grows or shrinks a correlation matrix to `n` legs, keeping every entry
 * that survives and filling new rows/columns with zero correlation and a
 * unit diagonal. Used when the user adds a leg. */
export function resizeCorrelation(matrix: number[][], n: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) {
      row.push(i === j ? 1 : (matrix[i]?.[j] ?? 0));
    }
    out.push(row);
  }
  return out;
}

/** Drops leg `index` from a correlation matrix: removes that row and that
 * column, leaving every other pairwise entry exactly where it was. Used
 * when the user removes a leg. */
export function removeFromCorrelation(matrix: number[][], index: number): number[][] {
  return matrix.filter((_, i) => i !== index).map((row) => row.filter((_, j) => j !== index));
}
