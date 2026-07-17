import { describe, expect, it } from 'vitest';
import { annualizedVolFromCloses, fetchHistVol, fetchRefRate } from '../src/services/marketFetch';
import { fetchImpliedFromOptions, toCboeSymbol } from '../src/services/impliedFetch';

// Live-network tests: skipped unless LIVE=1 (not suitable for CI).
// Run with: LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run tests/marketFetch.test.ts
const live = process.env.LIVE === '1' ? describe : describe.skip;

live('marketFetch (live network)', () => {
  it('fetches €STR for EUR', async () => {
    const r = await fetchRefRate('EUR');
    expect(r.rate).toBeGreaterThan(-0.02);
    expect(r.rate).toBeLessThan(0.1);
    expect(r.source).toContain('€STR');
    expect(r.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('fetches SOFR for USD', async () => {
    const r = await fetchRefRate('USD');
    expect(r.rate).toBeGreaterThan(0);
    expect(r.rate).toBeLessThan(0.15);
    expect(r.source).toContain('SOFR');
  });

  it('rejects unsupported currencies with a friendly message', async () => {
    await expect(fetchRefRate('JPY')).rejects.toThrow(/manually/);
  });

  it('estimates 1Y historical vol for AAPL', async () => {
    const r = await fetchHistVol('aapl.us');
    expect(r.vol).toBeGreaterThan(0.05);
    expect(r.vol).toBeLessThan(1.5);
    expect(r.days).toBeGreaterThan(100);
  });

  it('implies dividend yield and ATM vol from SPX options (European parity)', async () => {
    const r = await fetchImpliedFromOptions('SPX Index', 'index', 1, 0.036);
    expect(r.divYield).toBeGreaterThan(-0.01);
    expect(r.divYield).toBeLessThan(0.06);
    expect(r.atmVol).toBeGreaterThan(0.05);
    expect(r.atmVol).toBeLessThan(0.8);
    expect(r.spot).toBeGreaterThan(1000);
    expect(r.approximate).toBe(false);
  });

  it('implies from AAPL options (flagged approximate)', async () => {
    const r = await fetchImpliedFromOptions('AAPL', 'share', 1, 0.036);
    expect(r.divYield).toBeGreaterThan(-0.05);
    expect(r.divYield).toBeLessThan(0.2);
    expect(r.approximate).toBe(true);
  });

  it('fails loudly for unknown tickers', async () => {
    await expect(fetchImpliedFromOptions('ZZZZQQ', 'share', 1, 0.03)).rejects.toThrow(/no option chain|blocked/i);
  });
});

// Always-on tests: no network required.
describe('marketFetch (offline)', () => {
  it('throws for currencies without an open source', async () => {
    await expect(fetchRefRate('CHF')).rejects.toThrow(/enter the rate manually/);
  });

  it('computes annualized vol from synthetic closes', () => {
    // GBM path with known sigma=20%: sampled vol should land near 0.20.
    const sigma = 0.2;
    const dt = 1 / 252;
    let s = 100;
    const closes = [s];
    let seed = 123456789;
    const rand = () => {
      // Park-Miller
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 252; i++) {
      const u1 = rand();
      const u2 = rand();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      s *= Math.exp(-0.5 * sigma * sigma * dt + sigma * Math.sqrt(dt) * z);
      closes.push(s);
    }
    const { vol, days } = annualizedVolFromCloses(closes);
    expect(days).toBe(252);
    // stderr of vol estimate ~ sigma/sqrt(2n) ≈ 0.9%; allow 4x.
    expect(Math.abs(vol - sigma)).toBeLessThan(0.04);
  });

  it('rejects series that are too short', () => {
    expect(() => annualizedVolFromCloses([100, 101, 99])).toThrow(/Not enough/);
  });

  it('maps UI names to CBOE symbols', () => {
    expect(toCboeSymbol('SPX Index', 'index')).toBe('_SPX');
    expect(toCboeSymbol('^spx', 'index')).toBe('_SPX');
    expect(toCboeSymbol('aapl', 'share')).toBe('AAPL');
    expect(() => toCboeSymbol('  ', 'share')).toThrow(/ticker/);
  });
});
