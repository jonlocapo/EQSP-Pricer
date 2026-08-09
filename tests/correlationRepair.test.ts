import { describe, expect, it } from 'vitest';
import { isPsd, repairCorrelation } from '../src/model/correlation';

/**
 * Tests for the correlation-matrix repair layer. The known-bad case is the
 * 3x3 with all off-diagonals -0.7: it is pairwise-legal but carries a
 * negative eigenvalue, so a Cholesky factorization would fail on it.
 */

describe('isPsd', () => {
  it('accepts a 2x2 with a legal positive correlation', () => {
    expect(isPsd([[1, 0.5], [0.5, 1]])).toBe(true);
  });

  it('accepts the identity matrix', () => {
    expect(isPsd([[1, 0, 0], [0, 1, 0], [0, 0, 1]])).toBe(true);
  });

  it('rejects the known bad 3x3 with all off-diagonals -0.7', () => {
    const bad = [[1, -0.7, -0.7], [-0.7, 1, -0.7], [-0.7, -0.7, 1]];
    expect(isPsd(bad)).toBe(false);
  });
});

describe('repairCorrelation', () => {
  it('repairs the known bad 3x3 to a valid correlation matrix', () => {
    const bad = [[1, -0.7, -0.7], [-0.7, 1, -0.7], [-0.7, -0.7, 1]];
    const repaired = repairCorrelation(bad);

    expect(isPsd(repaired)).toBe(true);
    for (let i = 0; i < 3; i++) {
      expect(repaired[i][i]).toBeCloseTo(1, 10);
    }
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(repaired[i][j]).toBe(repaired[j][i]);
      }
    }
    expect(repaired).not.toEqual(bad);
  });

  it('leaves an already-valid 4x4 unchanged to full float precision', () => {
    const good = [
      [1, 0.4, 0.2, 0.1],
      [0.4, 1, 0.3, 0.2],
      [0.2, 0.3, 1, 0.4],
      [0.1, 0.2, 0.4, 1],
    ];
    const repaired = repairCorrelation(good);

    expect(repaired).toBe(good);
    expect(repaired).toEqual(good);
  });

  it('keeps every repaired eigenvalue at or above -1e-9', () => {
    const bad = [[1, -0.7, -0.7], [-0.7, 1, -0.7], [-0.7, -0.7, 1]];
    const repaired = repairCorrelation(bad);

    expect(isPsd(repaired)).toBe(true);
  });

  it('repairs a 3x3 with one illegal pair (rho 1.5)', () => {
    const illegal = [[1, 1.5, 0.2], [1.5, 1, 0.2], [0.2, 0.2, 1]];
    const repaired = repairCorrelation(illegal);

    expect(isPsd(repaired)).toBe(true);
    for (let i = 0; i < 3; i++) {
      expect(repaired[i][i]).toBeCloseTo(1, 10);
    }
  });

  it('degrades a rank-0 matrix to the identity', () => {
    const repaired = repairCorrelation([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    expect(repaired).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  });
});
