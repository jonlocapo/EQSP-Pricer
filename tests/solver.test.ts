import { describe, expect, it } from 'vitest';
import { brent, expandBracket } from '../src/engine/solver';

describe('brent', () => {
  it('finds sqrt(2) on x^2 - 2 in [0, 2]', () => {
    const { root } = brent((x) => x * x - 2, 0, 2);
    expect(root).toBeCloseTo(Math.sqrt(2), 5);
  });

  it('finds the root of cos(x) - x', () => {
    const { root } = brent((x) => Math.cos(x) - x, 0, 1);
    expect(root).toBeCloseTo(0.7390851, 5);
  });

  it('converges in a bounded number of iterations', () => {
    const { iterations } = brent((x) => x * x - 2, 0, 2);
    expect(iterations).toBeLessThanOrEqual(60);
  });
});

describe('expandBracket', () => {
  it('recovers a bracket when the initial one has no sign change', () => {
    // f(x) = x^2 - 2: initial [1.3, 1.4] has no sign change (both positive),
    // but expanding toward [-10, 10] finds one.
    const [lo, hi] = expandBracket((x) => x * x - 2, 1.3, 1.4, -10, 10);
    const fLo = lo * lo - 2;
    const fHi = hi * hi - 2;
    expect(fLo * fHi).toBeLessThanOrEqual(0);
  });

  it('throws when the function has no root within the hard bounds', () => {
    // f(x) = x^2 + 1 is always positive; no root anywhere.
    expect(() => expandBracket((x) => x * x + 1, 0.5, 0.6, -5, 5)).toThrow();
  });
});
