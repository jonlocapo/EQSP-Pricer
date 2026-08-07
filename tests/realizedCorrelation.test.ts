import { describe, expect, it } from 'vitest';
import { realizedCorrelation, type DatedClose } from '../src/services/marketFetch';

/**
 * Realized correlation is the correlation input for a worst-of basket.
 * A worst-of price is far more sensitive to correlation than to any single
 * vol. A wrong correlation misprices the product more than a wrong vol.
 * The app fetches two years of daily bars per name. The correlation must
 * use the SAME bars, aligned by UTC calendar date. A missing trading day
 * on one calendar (German vs US holidays) must DROP that day's pair.
 * It must never shift the later pairs onto the wrong dates.
 */

/** Day zero: 2025-01-01 00:00 UTC. */
const DAY0_EPOCH = 1735689600;
const DAY_SECONDS = 86400;

/** Deterministic LCG uniform draw, so the test never uses Math.random. */
function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state + 0.5) / 4294967296;
  };
}

/** Deterministic standard-normal samples via Box-Muller. */
function normals(n: number, seed: number): number[] {
  const u = makeLcg(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const radius = Math.sqrt(-2 * Math.log(u()));
    out.push(radius * Math.cos(2 * Math.PI * u()));
  }
  return out;
}

/** Builds a DatedClose series from daily log-returns. Day i is DAY0 + i*86400. */
function closeSeriesFromReturns(rets: number[]): DatedClose[] {
  const out: DatedClose[] = [];
  let close = 100;
  for (let i = 0; i < rets.length; i++) {
    close *= Math.exp(rets[i]);
    out.push({ t: DAY0_EPOCH + i * DAY_SECONDS, close });
  }
  return out;
}

/**
 * Builds two series whose daily log-returns have known correlation rho.
 * Asset B's return is rho*a + sqrt(1-rho^2)*b for independent normals.
 */
function correlatedSeries(
  rho: number,
  n: number,
  seed: number,
): { a: DatedClose[]; b: DatedClose[] } {
  const retA = normals(n, seed);
  const noise = normals(n, seed + 100000);
  const retB = retA.map((x, i) => rho * x + Math.sqrt(1 - rho * rho) * noise[i]);
  return { a: closeSeriesFromReturns(retA), b: closeSeriesFromReturns(retB) };
}

describe('realizedCorrelation', () => {
  it('recovers a known positive correlation', () => {
    const { a, b } = correlatedSeries(0.6, 500, 2);
    const measured = realizedCorrelation(a, b);
    // 500 returns give a small sample error. The fixed seed makes the draw
    // reproducible, and this seed lands within 0.005 of the true rho.
    expect(measured).toBeCloseTo(0.6, 2);
  });

  it('recovers a known negative correlation', () => {
    const { a, b } = correlatedSeries(-0.3, 500, 21);
    const measured = realizedCorrelation(a, b);
    expect(measured).toBeCloseTo(-0.3, 2);
  });

  it('drops a missing trading day instead of shifting later pairs', () => {
    const { a, b } = correlatedSeries(0.6, 500, 2);
    // Remove ~10 random interior days from B, like a German holiday on the
    // US calendar. The dates keep their original positions; entries vanish.
    const u = makeLcg(999);
    const drops = new Set<number>();
    while (drops.size < 10) drops.add(5 + Math.floor(u() * 490));
    const bShort = b.filter((_, i) => !drops.has(i));

    const measured = realizedCorrelation(a, bShort);
    expect(Number.isFinite(measured)).toBe(true);
    // Dropping a day must discard that date's pair, not realign the rest.
    // A shifted alignment would scatter the later returns and wreck rho.
    expect(Math.abs(measured - 0.6)).toBeLessThan(0.02);
  });

  it('throws when fewer than 31 overlapping days remain', () => {
    // Zero overlap: A covers days 0..29, B covers days 30..59.
    const a: DatedClose[] = Array.from({ length: 30 }, (_, i) => ({
      t: DAY0_EPOCH + i * DAY_SECONDS,
      close: 100,
    }));
    const b: DatedClose[] = Array.from({ length: 30 }, (_, i) => ({
      t: DAY0_EPOCH + (i + 30) * DAY_SECONDS,
      close: 100,
    }));
    expect(() => realizedCorrelation(a, b)).toThrow();
  });

  it('throws at 30 overlapping days and accepts 31', () => {
    // The code needs at least 31 aligned points. Pin the boundary exactly.
    const a: DatedClose[] = Array.from({ length: 60 }, (_, i) => ({
      t: DAY0_EPOCH + i * DAY_SECONDS,
      close: 100,
    }));
    const b30: DatedClose[] = Array.from({ length: 30 }, (_, i) => ({
      t: DAY0_EPOCH + (i + 30) * DAY_SECONDS,
      close: 100,
    }));
    const b31: DatedClose[] = Array.from({ length: 31 }, (_, i) => ({
      t: DAY0_EPOCH + (i + 29) * DAY_SECONDS,
      close: 100,
    }));
    expect(() => realizedCorrelation(a, b30)).toThrow();
    // 31 aligned points give a degenerate (all-zero) return series.
    // The function must accept the window and report zero correlation.
    expect(realizedCorrelation(a, b31)).toBe(0);
  });

  it('returns the identical value for the identical inputs', () => {
    const { a, b } = correlatedSeries(0.6, 500, 2);
    expect(realizedCorrelation(a, b)).toBe(realizedCorrelation(a, b));
  });
});
