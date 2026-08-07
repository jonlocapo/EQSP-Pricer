import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchTextWithCorsFallback,
  __resetPreferredRoutes,
  recentRouteAttempts,
  __clearRouteAttempts,
} from '../src/services/spotFetch';

// Deterministic offline harness for the hedge/relay ladder's TIMING and
// BOOKKEEPING. Follows the fake-fetch pattern from corsHedge.test.ts: match
// routes on the URL's ORIGIN, never on a substring. A relay URL carries the
// encoded target inside its query string, so matching a target hostname
// against the raw relay URL would wrongly count the relay as the direct
// route. These tests assert timings and diagnostics only, never market data,
// so they never touch the real network.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});
beforeEach(() => {
  __resetPreferredRoutes();
  __clearRouteAttempts();
});

/** A fake fetch where each route has its own latency and outcome, keyed by
 * ORIGIN of the outgoing request. */
function fakeFetch(routes: { match: string; delayMs: number; body?: string; fail?: boolean }[]) {
  const calls: string[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) =>
    new Promise((resolve, reject) => {
      calls.push(url);
      let origin = url;
      try {
        origin = new URL(url).origin;
      } catch {
        /* keep the raw string */
      }
      const r = routes.find((x) => origin.includes(x.match));
      const delay = r?.delayMs ?? 10_000;
      const t = setTimeout(() => {
        if (!r || r.fail) reject(new Error('route failed'));
        else resolve({ ok: true, text: async () => r.body ?? '{"ok":1}' } as Response);
      }, delay);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      });
    })) as unknown as typeof fetch;
  return calls;
}

describe('fetch ladder timing diagnostics', () => {
  it('is not dramatically slower cold (empty route memo) than warm (remembered route)', async () => {
    // Direct fails instantly; the first relay (proxy.cors.sh) answers in 150ms.
    // Cold: the memo is empty, so this call starts at 'direct' and hedges
    // into the relay after the hedge delay. Warm: the memo already points at
    // it, so it is tried first with no hedge wait at all. The user's report
    // that this claim needed verifying, not assuming, is the reason this test
    // exists: assert cold is not dramatically slower, not that it is identical.
    // The relay delay (150ms) stays under the hedge interval (200ms) counted
    // from when the relay itself started, so no third route is hedged in
    // before the relay answers. That keeps routesStarted deterministic: 2
    // cold (direct fails, then the relay wins), 1 warm (relay wins outright).
    fakeFetch([
      { match: 'query1.finance.yahoo.com', delayMs: 5, fail: true },
      { match: 'proxy.cors.sh', delayMs: 150, body: '{"cold":1}' },
    ]);
    const coldStart = performance.now();
    const cold = await fetchTextWithCorsFallback('https://query1.finance.yahoo.com/x', 5000, () => true, 200);
    const coldMs = performance.now() - coldStart;
    expect(cold.text).toBe('{"cold":1}');

    // Warm: same routes, but the memo now points straight at the relay.
    fakeFetch([
      { match: 'query1.finance.yahoo.com', delayMs: 5, fail: true },
      { match: 'proxy.cors.sh', delayMs: 150, body: '{"warm":1}' },
    ]);
    const warmStart = performance.now();
    const warm = await fetchTextWithCorsFallback('https://query1.finance.yahoo.com/x', 5000, () => true, 200);
    const warmMs = performance.now() - warmStart;
    expect(warm.text).toBe('{"warm":1}');

    // eslint-disable-next-line no-console
    console.log(`cold=${coldMs.toFixed(1)}ms warm=${warmMs.toFixed(1)}ms`);

    // Both calls are dominated by the same 150ms relay latency; the hedge
    // delay before the cold call reaches that relay is at most 200ms on top.
    // "Not dramatically slower" here means well under an order of magnitude,
    // not bit-for-bit equal.
    expect(coldMs).toBeLessThan(warmMs * 10 + 500);

    const attempts = recentRouteAttempts();
    expect(attempts).toHaveLength(2);
    expect(attempts[0].winner).toBe('proxy.cors.sh');
    expect(attempts[0].routesStarted).toBe(2); // direct started, failed, then the relay started
    expect(attempts[1].winner).toBe('proxy.cors.sh');
    expect(attempts[1].routesStarted).toBe(1); // memo sent the relay first, and it answered
  });

  it('overtakes a stalled first relay instead of waiting it out', async () => {
    // Direct fails instantly. Relay 1 (allorigins) takes 9s, far past any
    // sane hedge. A later relay (codetabs) answers in 150ms. The hedge must
    // start codetabs without waiting for the stalled one, so the call
    // completes in well under 9s.
    fakeFetch([
      { match: 'query1.finance.yahoo.com', delayMs: 5, fail: true },
      { match: 'proxy.cors.sh', delayMs: 9000, body: '{"slow":1}' },
      { match: 'api.codetabs.com', delayMs: 150, body: '{"fast":1}' },
    ]);
    const t0 = performance.now();
    const { text } = await fetchTextWithCorsFallback('https://query1.finance.yahoo.com/x', 15000, () => true, 200);
    const ms = performance.now() - t0;
    expect(text).toBe('{"fast":1}');
    expect(ms).toBeLessThan(3000); // well under the 9s a stalled relay would cost

    const attempts = recentRouteAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].winner).toBe('api.codetabs.com');
    // direct, cors.sh (stalled), allorigins (unmatched -> default slow), then
    // codetabs all started before codetabs won.
    expect(attempts[0].routesStarted).toBe(4);
    expect(attempts[0].ms).toBeLessThan(3000);
  });

  it('records the worst-case timing when every route fails', async () => {
    fakeFetch([{ match: 'nothing-matches-anything', delayMs: 1 }]);
    const t0 = performance.now();
    await expect(
      fetchTextWithCorsFallback('https://query1.finance.yahoo.com/x', 300, () => true, 50),
    ).rejects.toThrow();
    const ms = performance.now() - t0;

    // eslint-disable-next-line no-console
    console.log(`total failure took ${ms.toFixed(1)}ms`);

    const attempts = recentRouteAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].winner).toBeNull();
    expect(attempts[0].routesStarted).toBe(5); // direct + 4 relays, all started
    expect(attempts[0].error).toBeTruthy();
    expect(attempts[0].ms).toBeGreaterThan(0);
    expect(attempts[0].ms).toBeLessThan(2000);
  });

  it('keeps the diagnostics buffer bounded to the most recent entries', async () => {
    fakeFetch([{ match: 'query1.finance.yahoo.com', delayMs: 1, body: '{"ok":1}' }]);
    for (let i = 0; i < 60; i++) {
      await fetchTextWithCorsFallback(`https://query1.finance.yahoo.com/${i}`, 500, () => true, 200);
    }
    const attempts = recentRouteAttempts();
    expect(attempts.length).toBeLessThanOrEqual(50);
    expect(attempts.every((a) => a.winner === 'direct')).toBe(true);
  });
});
