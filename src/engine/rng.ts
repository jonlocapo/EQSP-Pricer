/**
 * Seeded pseudo-random number generation for reproducible Monte Carlo runs.
 */

/** mulberry32 PRNG. Returns a function producing floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Standard-normal generator via Box-Muller, seeded deterministically.
 * Each call to the returned function produces one N(0,1) draw; internally
 * two uniforms produce two normals per pair, the second cached and returned
 * on the following call.
 */
export function normals(seed: number): () => number {
  const rand = mulberry32(seed);
  let cached: number | null = null;
  return function (): number {
    if (cached !== null) {
      const v = cached;
      cached = null;
      return v;
    }
    let u1 = rand();
    // Avoid log(0).
    while (u1 <= Number.EPSILON) u1 = rand();
    const u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    const z0 = r * Math.cos(theta);
    const z1 = r * Math.sin(theta);
    cached = z1;
    return z0;
  };
}
