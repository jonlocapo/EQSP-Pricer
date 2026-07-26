import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchOptionChainMarketData,
  pickExpiries,
  MIN_SANE_IV,
  MAX_SANE_IV,
} from '../src/services/marketDataApp';

/**
 * Pure, offline tests for the marketdata.app chain fetcher. `fetch` is
 * stubbed with a hand-written fixture in the exact column-oriented shape a
 * live probe of the real endpoint returned. No network is used.
 */

const SYMBOL = 'AAPL';
const SPOT = 333.48;

function expirationsBody(expirations: string[]) {
  return JSON.stringify({ s: 'ok', expirations });
}

/** Builds one expiry's column-oriented chain response from row objects,
 * matching marketdata.app's actual parallel-array shape. */
function chainBody(expiry: string, rows: { strike: number; side: 'call' | 'put'; iv?: number | null }[]) {
  const expSeconds = Math.floor(new Date(`${expiry}T21:00:00Z`).getTime() / 1000);
  const cols = {
    s: 'ok',
    optionSymbol: rows.map((_, i) => `AAPL${i}`),
    side: rows.map((r) => r.side),
    strike: rows.map((r) => r.strike),
    expiration: rows.map(() => expSeconds),
    bid: rows.map((r) => r.strike - 1),
    ask: rows.map((r) => r.strike + 1),
    mid: rows.map((r) => r.strike),
    last: rows.map((r) => r.strike),
    iv: rows.map((r) => r.iv ?? undefined),
    underlyingPrice: rows.map(() => SPOT),
  };
  return JSON.stringify(cols);
}

function stubFetch(handler: (url: string) => { status: number; body: string }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const { status, body } = handler(url);
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
      } as Response;
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pickExpiries', () => {
  const NOW = new Date('2026-07-26T00:00:00Z').getTime();
  // Roughly: +5d, +30d, +130d, +250d, +400d out from NOW.
  const expirations = ['2026-07-31', '2026-08-25', '2026-12-03', '2027-04-02', '2027-08-30'];

  it('skips anything inside 10 days out', () => {
    const picked = pickExpiries(expirations, 1, NOW);
    expect(picked).not.toContain('2026-07-31');
  });

  it('picks at most three expiries', () => {
    const picked = pickExpiries(expirations, 1, NOW);
    expect(picked.length).toBeLessThanOrEqual(3);
  });

  it('spans the tenor: nearest to 1/3, 2/3, and the full tenor', () => {
    // tenorYears = 1 -> targets at ~0.33y (~120d), ~0.67y (~245d), ~1y (~365d)
    const picked = pickExpiries(expirations, 1, NOW);
    expect(picked).toContain('2026-12-03'); // ~130d, nearest to 1/3
    expect(picked).toContain('2027-04-02'); // ~250d, nearest to 2/3
    expect(picked).toContain('2027-08-30'); // ~400d, nearest to the full tenor
  });

  it('returns nothing when every expiry is inside the 10-day floor', () => {
    const picked = pickExpiries(['2026-07-28'], 1, NOW);
    expect(picked).toEqual([]);
  });
});

describe('fetchOptionChainMarketData', () => {
  const EXPIRY = '2027-01-15';

  it('unzips the column-oriented chain into the shared OptionChain shape', async () => {
    stubFetch((url) => {
      if (url.includes('/expirations/')) return { status: 200, body: expirationsBody([EXPIRY]) };
      return {
        status: 203, // marketdata.app answers delayed quotes with 203, not 200
        body: chainBody(EXPIRY, [
          { strike: 340, side: 'call', iv: 0.31 },
          { strike: 320, side: 'call', iv: 0.29 },
          { strike: 330, side: 'put', iv: 0.3 },
          { strike: 310, side: 'put', iv: 0.33 },
        ]),
      };
    });

    const chain = await fetchOptionChainMarketData(SYMBOL, 1, SPOT);
    expect(chain.symbol).toBe(SYMBOL);
    expect(chain.spot).toBe(SPOT);
    expect(chain.source).toMatch(/marketdata\.app/);
    expect(chain.slices).toHaveLength(1);

    const slice = chain.slices[0];
    expect(slice.expiry).toBe(EXPIRY);
    expect(slice.calls.map((c) => c.strike)).toEqual([320, 340]);
    expect(slice.puts.map((p) => p.strike)).toEqual([310, 330]);
  });

  it('drops a garbage deep-ITM iv (0.0001) and an implausibly high iv (5), keeps a sane one (0.30)', async () => {
    stubFetch((url) => {
      if (url.includes('/expirations/')) return { status: 200, body: expirationsBody([EXPIRY]) };
      return {
        status: 200,
        body: chainBody(EXPIRY, [
          { strike: 255, side: 'call', iv: 0.0001 }, // measured garbage case, deep ITM
          { strike: 100, side: 'put', iv: 5 }, // implausibly high
          { strike: 330, side: 'call', iv: 0.3 }, // sane, kept
        ]),
      };
    });

    const chain = await fetchOptionChainMarketData(SYMBOL, 1, SPOT);
    const allRows = chain.slices.flatMap((s) => [...s.calls, ...s.puts]);
    expect(allRows).toHaveLength(1);
    expect(allRows[0].strike).toBe(330);
    expect(allRows[0].iv).toBeCloseTo(0.3, 10);
  });

  it('pins the sane-iv band to MIN_SANE_IV / MAX_SANE_IV at the boundary', async () => {
    stubFetch((url) => {
      if (url.includes('/expirations/')) return { status: 200, body: expirationsBody([EXPIRY]) };
      return {
        status: 200,
        body: chainBody(EXPIRY, [
          { strike: 300, side: 'call', iv: MIN_SANE_IV - 0.001 }, // just below floor, dropped
          { strike: 310, side: 'call', iv: MIN_SANE_IV + 0.001 }, // just above floor, kept
          { strike: 320, side: 'put', iv: MAX_SANE_IV + 0.001 }, // just above ceiling, dropped
          { strike: 330, side: 'put', iv: MAX_SANE_IV - 0.001 }, // just below ceiling, kept
        ]),
      };
    });

    const chain = await fetchOptionChainMarketData(SYMBOL, 1, SPOT);
    const strikes = chain.slices.flatMap((s) => [...s.calls, ...s.puts]).map((r) => r.strike);
    expect(strikes.sort((a, b) => a - b)).toEqual([310, 330]);
  });

  it('throws when the expirations endpoint reports s !== "ok"', async () => {
    stubFetch(() => ({ status: 200, body: JSON.stringify({ s: 'no_data' }) }));
    await expect(fetchOptionChainMarketData(SYMBOL, 1, SPOT)).rejects.toThrow(/no option expiries/i);
  });

  it('throws when the symbol has no listed expiries at all', async () => {
    stubFetch((url) => {
      if (url.includes('/expirations/')) return { status: 200, body: expirationsBody([]) };
      return { status: 200, body: JSON.stringify({ s: 'no_data' }) };
    });
    await expect(fetchOptionChainMarketData(SYMBOL, 1, SPOT)).rejects.toThrow(/no option expiries/i);
  });

  it('throws rather than returning an empty surface when every row is filtered out', async () => {
    stubFetch((url) => {
      if (url.includes('/expirations/')) return { status: 200, body: expirationsBody([EXPIRY]) };
      return {
        status: 200,
        body: chainBody(EXPIRY, [
          { strike: 255, side: 'call', iv: 0.0001 },
          { strike: 100, side: 'put', iv: 5 },
        ]),
      };
    });
    await expect(fetchOptionChainMarketData(SYMBOL, 1, SPOT)).rejects.toThrow(/no usable/i);
  });

  it('takes spot from the response underlyingPrice when the caller passes none', async () => {
    stubFetch((url) => {
      if (url.includes('/expirations/')) return { status: 200, body: expirationsBody([EXPIRY]) };
      return {
        status: 200,
        body: chainBody(EXPIRY, [{ strike: 330, side: 'call', iv: 0.3 }]),
      };
    });
    const chain = await fetchOptionChainMarketData(SYMBOL, 1);
    expect(chain.spot).toBe(SPOT);
  });
});
