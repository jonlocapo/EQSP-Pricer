import { afterEach, describe, expect, it, vi } from 'vitest';
import { __clearSearchCacheForTests, searchSymbols } from '../src/services/symbolSearch';
import { __resetPreferredRoutes } from '../src/services/spotFetch';
import { LOCAL_UNIVERSE, searchLocalUniverse } from '../src/services/localUniverse';

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
    // A query the built-in list does NOT know, so the network path is what is
    // actually under test here rather than the local fallback.
    vi.stubGlobal('fetch', mockFetchSequence(RELAY_ERROR, GOOD));
    const out = await searchSymbols('obscurecorp');
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe('RHM.DE');
    expect(out[0].currency).toBe('EUR');
  });

  it('reports a failure rather than claiming the ticker does not exist', async () => {
    // Every route answers with an error body. That is search being unavailable,
    // and it must throw, because "no matches" would be a lie the user acts on.
    vi.stubGlobal('fetch', mockFetchSequence(RELAY_ERROR));
    await expect(searchSymbols('obscurecorp')).rejects.toThrow();
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
    await expect(searchSymbols('obscurecorp')).resolves.toEqual([]);

    vi.stubGlobal('fetch', mockFetchSequence(GOOD));
    const second = await searchSymbols('obscurecorp');
    expect(second).toHaveLength(1);
  });

  it('serves a repeat hit from memory without touching the network', async () => {
    // The cache still has to do its job: typing walks prefixes, so the same
    // query is asked for repeatedly within seconds.
    vi.stubGlobal('fetch', mockFetchSequence(GOOD));
    await searchSymbols('obscurecorp');
    const boom = vi.fn(() => {
      throw new Error('a cached query must not fetch');
    });
    vi.stubGlobal('fetch', boom);
    await expect(searchSymbols('OBSCURECORP')).resolves.toHaveLength(1);
    expect(boom).not.toHaveBeenCalled();
  });
});

describe('local universe fallback', () => {
  it('finds a name with the network completely dead', async () => {
    // The point of the built-in list: typing a NAME must work when every relay
    // is down, because knowing "RHM.DE" by heart is not reasonable.
    vi.stubGlobal('fetch', mockFetchSequence(new Error('relay down')));
    const out = await searchSymbols('rheinmetall');
    expect(out[0].symbol).toBe('RHM.DE');
    expect(out[0].currency).toBe('EUR');
  });

  it('paints local hits before the network answers', async () => {
    vi.stubGlobal('fetch', mockFetchSequence(GOOD));
    const painted: string[][] = [];
    await searchSymbols('nestle', (m) => painted.push(m.map((x) => x.symbol)));
    expect(painted[0]).toContain('NESN.SW');
  });

  it('ranks an exact symbol and a symbol root above a buried name match', () => {
    expect(searchLocalUniverse('rhm')[0].symbol).toBe('RHM.DE');
    expect(searchLocalUniverse('NESN.SW')[0].symbol).toBe('NESN.SW');
    // An index code people say out loud, which appears in no name.
    expect(searchLocalUniverse('sx5e')[0].symbol).toBe('^STOXX50E');
    expect(searchLocalUniverse('spx')[0].symbol).toBe('^GSPC');
  });

  it('ignores accents and punctuation in a name', () => {
    // "Nestle" is spelt "Nestle" in the list but users type it either way, and
    // "L'Oreal" has an apostrophe nobody reaches for.
    expect(searchLocalUniverse('nestlé')[0].symbol).toBe('NESN.SW');
    expect(searchLocalUniverse('loreal')[0].symbol).toBe('OR.PA');
  });

  it('lets the network row win for a symbol both sources know', async () => {
    // The network carries the live name and listing currency, so it must not be
    // shadowed by the built-in row, and the symbol must not appear twice.
    const both = JSON.stringify({
      quotes: [{ symbol: 'NESN.SW', longname: 'Nestle S.A.', exchDisp: 'Swiss', quoteType: 'EQUITY', currency: 'CHF' }],
    });
    vi.stubGlobal('fetch', mockFetchSequence(both));
    const out = await searchSymbols('nestle');
    expect(out.filter((m) => m.symbol === 'NESN.SW')).toHaveLength(1);
    expect(out[0].name).toBe('Nestle S.A.');
  });

  it('has no duplicate symbols in the built-in list', () => {
    const seen = new Set<string>();
    for (const e of LOCAL_UNIVERSE) {
      expect(seen.has(e.symbol), `duplicate ${e.symbol}`).toBe(false);
      seen.add(e.symbol);
      // Every row must carry a currency, because picking one sets the note
      // currency and a missing value would silently leave a mismatch.
      expect(e.currency, `no currency on ${e.symbol}`).toBeTruthy();
    }
  });
});
