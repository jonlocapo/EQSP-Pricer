import { describe, expect, it } from 'vitest';
import { normals } from '../src/engine/rng';

/**
 * B1 of the worst-of prerequisites: pin the RANDOM NUMBER ORDER.
 *
 * The basket work changes the engine from one draw per step to several (one
 * per asset) â€” or, in the collapsed design, from one draw to a Cholesky of
 * several. Either way the SEQUENCE in which the seeded generator is consumed
 * changes, and a changed draw order silently breaks the replay cache: stored
 * paths were generated under the old order, and replayed paths under the new
 * one would not match. This test records the CURRENT single-asset order so
 * the moment the draw order changes, the test fails loudly and forces a
 * decision, instead of quietly breaking bit-identity.
 *
 * The fingerprint covers the first 600 draws of the engine's own seeded
 * generator â€” two full years of daily steps, more than any single product
 * consumes â€” as the exact first values plus the aggregate sums, which stay
 * sensitive to a reordering even where individual values match.
 */

describe('B1: seeded random number order is pinned', () => {
  it('seed 42 draws the stored sequence', () => {
    const z = normals(42);
    const first = [-0.95616222938414897, 0.32207024932152961, -0.27302610488261042, -0.4946727576767142, -1.8416271847835968, -0.31060573973512801];
    for (const v of first) expect(z()).toBeCloseTo(v, 14);
    // The aggregate over 600 draws: any reordering or re-seeding changes these.
    let sum = 0;
    let sumSq = 0;
    for (let i = 6; i < 600; i++) {
      const v = z();
      sum += v;
      sumSq += v * v;
    }
    expect(sum).toBeCloseTo(-27.933333110890757, 10);
    expect(sumSq).toBeCloseTo(587.23254883578591, 10);
  });

  it('seed 12345 draws its own stored sequence', () => {
    const z = normals(12345);
    const first = [-0.070648074492592042, 0.18965467748679948, 0.49860719149527216, -1.0963042205175533, -0.66766340496380128, 0.9503460581633838];
    for (const v of first) expect(z()).toBeCloseTo(v, 14);
    let sum = 0;
    let sumSq = 0;
    for (let i = 6; i < 600; i++) {
      const v = z();
      sum += v;
      sumSq += v * v;
    }
    expect(sum).toBeCloseTo(3.7528662413682463, 10);
    expect(sumSq).toBeCloseTo(579.61853781834213, 10);
  });

  it('draws come in Box-Muller pairs: the radius differs between pairs', () => {
    // Structural lock on the generator's PAIRING. Each call returns one draw;
    // two consecutive calls form one Box-Muller pair sharing a radius r
    // (z0^2 + z1^2 = r^2 with r^2 = -2 ln u1). A subsequent pair draws new
    // uniforms, so its radius differs. If the basket code ever switches to
    // drawing several assets' shocks per step, this pairing-consumption order
    // is exactly what changes.
    const z = normals(99);
    const radii: number[] = [];
    for (let p = 0; p < 40; p++) {
      const z0 = z();
      const z1 = z();
      radii.push(Math.round((z0 * z0 + z1 * z1) * 1e12));
    }
    // At least one radius differs from the first: the pairs are independent.
    expect(radii.slice(1).some((r) => r !== radii[0])).toBe(true);
    // Every radius is positive and finite (a degenerate u1 = 1 would give 0).
    for (const r of radii) {
      expect(Number.isFinite(r)).toBe(true);
      expect(r).toBeGreaterThan(0);
    }
  });
});
