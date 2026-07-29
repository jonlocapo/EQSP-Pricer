import { describe, expect, it } from 'vitest';
import { normCdf } from '../src/engine/blackScholes';

/**
 * Ground truth generated externally with mpmath at 30-50 decimal digits
 * (`mp.dps = 30; ncdf(mpf(x))`), independent of this codebase's own
 * arithmetic. Pinning against an external high-precision source, rather
 * than against this file's own normCdf, is what actually tests the
 * function instead of testing that it agrees with itself.
 */
const REFERENCE: [number, number][] = [
  [0, 0.5],
  [-1, 0.1586552539314570514147674543679620775220870332734],
  [-2, 0.022750131948179207200282637166533437471776223701678],
  [-5, 0.00000028665157187919391167375233287464535385442301361189],
  [-8, 6.2209605742717841235159951725881884224887172789003e-16],
  [-10, 7.619853024160526065973343251599308363504033277957e-24],
  [-15, 3.6709661993127508857860896553347434864162516280402e-51],
  [1, 0.8413447460685429485852325456320379224779129667266],
  [2, 0.97724986805182079279971736283346656252822377629832],
  [5, 0.99999971334842812080608832624766712535464614557699],
  [8, 0.99999999999999937790394257282158764840048274118116],
  [10, 0.99999999999999999999999238014697583947393402665675],
  [-0.5, 0.30853753872598689636229538939166226011639782444542],
  [0.5, 0.69146246127401310363770461060833773988360217555458],
  [-3, 0.0013498980316300945266518147675949773778293681583806],
  [3, 0.99865010196836990547334818523240502262217063184162],
  [-0.001, 0.499601057786088937407105027236],
  [0.999, 0.841102654358681713706503207556],
  [1.001, 0.841586595807719965932953111767],
  [-20, 2.75362411860623369507562278086e-89],
  [-30, 4.90671392714818705953380925658e-198],
];

describe('normCdf — accuracy against an independent high-precision reference', () => {
  it('matches mpmath to a tight RELATIVE tolerance across the whole range, including the deep tail', () => {
    for (const [x, expected] of REFERENCE) {
      const got = normCdf(x);
      if (expected === 0.5 && x === 0) {
        expect(got).toBe(0.5);
        continue;
      }
      const relErr = Math.abs(got - expected) / Math.abs(expected);
      // The old Abramowitz-Stegun 7.1.26 fit carried an ABSOLUTE error of
      // 1e-7, which is a hundred times the whole value at x=-5 (N(-5) ~
      // 2.9e-7) and meaningless deep in the wings. This implementation is
      // relative-error accurate, so the bar is a relative tolerance, and it
      // must hold whether x is 0.5 or -30.
      expect(relErr).toBeLessThan(2e-12);
    }
  });

  it('does not flush the deep tail to zero — the whole point of the fix', () => {
    // The old fit's 1e-7 absolute error would have reported these as 0.
    expect(normCdf(-8)).toBeGreaterThan(0);
    expect(normCdf(-10)).toBeGreaterThan(0);
    expect(normCdf(-15)).toBeGreaterThan(0);
    expect(normCdf(-20)).toBeGreaterThan(0);
    expect(normCdf(-30)).toBeGreaterThan(0);
    // And each is within an order of magnitude of the true value — not just
    // "nonzero by float noise".
    expect(normCdf(-15)).toBeLessThan(1e-49);
    expect(normCdf(-15)).toBeGreaterThan(1e-52);
  });

  it('is symmetric: N(x) + N(-x) = 1 to machine precision', () => {
    for (const x of [0.001, 0.5, 1, 2, 5, 8, 10, 15, 20]) {
      expect(normCdf(x) + normCdf(-x)).toBeCloseTo(1, 14);
    }
  });

  it('is monotonically non-decreasing on a fine grid', () => {
    let prev = normCdf(-10);
    for (let x = -9.9; x <= 10; x += 0.1) {
      const cur = normCdf(x);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });
});
