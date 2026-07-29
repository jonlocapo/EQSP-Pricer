import { describe, expect, it } from 'vitest';
import { nelderMead } from '../src/model/optimize';

describe('nelderMead', () => {
  it('minimizes a simple convex bowl (sphere function) to its known minimum', () => {
    const f = (x: number[]) => (x[0] - 3) ** 2 + (x[1] + 1) ** 2 + 5;
    const result = nelderMead(f, [0, 0]);
    expect(result.converged).toBe(true);
    expect(result.x[0]).toBeCloseTo(3, 3);
    expect(result.x[1]).toBeCloseTo(-1, 3);
    expect(result.fx).toBeCloseTo(5, 3);
  });

  it('minimizes the Rosenbrock banana function (a standard hard case)', () => {
    const f = (x: number[]) => (1 - x[0]) ** 2 + 100 * (x[1] - x[0] * x[0]) ** 2;
    const result = nelderMead(f, [-1, 1], { maxIter: 2000 });
    expect(result.x[0]).toBeCloseTo(1, 1);
    expect(result.x[1]).toBeCloseTo(1, 1);
  });

  it('reports non-convergence when starved of iterations, rather than lying', () => {
    const f = (x: number[]) => (x[0] - 3) ** 2 + (x[1] + 1) ** 2;
    const result = nelderMead(f, [0, 0], { maxIter: 1 });
    expect(result.converged).toBe(false);
  });
});
