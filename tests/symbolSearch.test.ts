import { afterEach, describe, expect, it, vi } from 'vitest';
import { __clearSearchCacheForTests, searchSymbols } from '../src/services/symbolSearch';
import { __resetPreferredRoutes } from '../src/services/spotFetch';

/**
 * Ticker search fails through public CORS relays, and a relay that is down
 * usually answers with its OWN error body rather than refusing the connection.
 * Every test here is about telling that apart from a genuine "no such ticker",
 * because confusing the two told the user a real name did not exist.
 */

const GOOD = JSON.stringify({
  quotes: [
    { symbol: 'RHM.DE', shortname: 'Rheinmetall AG', exchDisp: 'XETRA', quoteType: 'EQUITY', currency: 'EUR' },
  ],
});
/** Yahoo's answer when it genuinely knows nothing: the key is present, empty. */
const GENUINELY_EMPTY = JSON.stringify({ count: 0, quotes: [] });
/** What a rate-limited relay sends. Valid JSON, starts with a brace, useless. */
const RELAY_ERROR = JSON.stringify({ error: 'Rate limit exceeded', status: 429 });

function mockFetchSequence(...bodies: (string | Error)[]) {
  let i = 0;
  return vi.fn(async () => {
    const body = bodies[Math.min(i++, bodies.length - 1)];
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, text: async () => body } as unknown as Response;
  });
}

afterEach(() => {
  __clearSearchCacheForTests();
  __resetPreferredRoutes();
  vi.unstubAllGlobals();
});

describe('ticker search', () => {
  it('does not let a relay error body win the hedged race', async () => {
    // The direct request is answered by a relay-style error, and a later route
    // has the real answer. The old validator accepted any body starting with a
    // brace, so the error won, aborted the routes still in flight, and the user
    // saw no matches for a real ticker.
    vi.stubGlobal('fetch', mockFetchSequence(RELAY_ERROR, GOOD));
    const out = await searchSymbols('rheinmetall');
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe('RHM.DE');
    expect(out[0].currency).toBe('EUR');
  });

  it('reports a failure rather than claiming the ticker does not exist', async () => {
    // Every route answers with an error body. That is search being unavailable,
    // and it must throw, because "no matches" would be a lie the user acts on.
    vi.stubGlobal('fetch', mockFetchSequence(RELAY_ERROR));
    await expect(searchSymbols('rheinmetall')).rejects.toThrow();
  });

  it('tells a genuine empty result apart from a broken one', async () => {
    // `"quotes": []` is Yahoo saying it knows nothing. That is a real answer,
    // so it resolves empty instead of throwing.
    vi.stubGlobal('fetch', mockFetchSequence(GENUINELY_EMPTY));
    await expect(searchSymbols('zzzzznotaticker')).resolves.toEqual([]);
  });

  it('never caches an empty result, so one bad answer cannot poison a query', async () => {
    // The bug this pins: an empty array is TRUTHY, so caching it meant the
    // cache served it for the rest of the session and no later attempt could
    // replace it. Search stayed broken for that query until a page reload.
    vi.stubGlobal('fetch', mockFetchSequence(GENUINELY_EMPTY));
    await expect(searchSymbols('rheinmetall')).resolves.toEqual([]);

    vi.stubGlobal('fetch', mockFetchSequence(GOOD));
    const second = await searchSymbols('rheinmetall');
    expect(second).toHaveLength(1);
  });

  it('serves a repeat hit from memory without touching the network', async () => {
    // The cache still has to do its job: typing walks prefixes, so the same
    // query is asked for repeatedly within seconds.
    vi.stubGlobal('fetch', mockFetchSequence(GOOD));
    await searchSymbols('rheinmetall');
    const boom = vi.fn(() => {
      throw new Error('a cached query must not fetch');
    });
    vi.stubGlobal('fetch', boom);
    await expect(searchSymbols('RHEINMETALL')).resolves.toHaveLength(1);
    expect(boom).not.toHaveBeenCalled();
  });
});
