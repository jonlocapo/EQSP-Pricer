import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fetchTextWithCorsFallback, __resetPreferredRoutes } from '../src/services/spotFetch';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });
beforeEach(() => __resetPreferredRoutes());

/** A fake fetch where each route has its own latency and outcome. */
function fakeFetch(routes: { match: string; delayMs: number; body?: string; fail?: boolean }[]) {
  const calls: string[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) =>
    new Promise((resolve, reject) => {
      calls.push(url);
      // Match on ORIGIN, not substring. A relay URL carries the encoded target
      // inside its query string, so a substring match on the target host would
      // wrongly classify the relay as the direct route.
      let origin = url;
      try { origin = new URL(url).origin; } catch { /* keep the raw string */ }
      const r = routes.find((x) => origin.includes(x.match));
      const delay = r?.delayMs ?? 10_000;
      const t = setTimeout(() => {
        if (!r || r.fail) reject(new Error('route failed'));
        else resolve({ ok: true, text: async () => r.body ?? '{"ok":1}' } as Response);
      }, delay);
      init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
    })) as unknown as typeof fetch;
  return calls;
}

describe('hedged CORS fallback', () => {
  it('does not wait out a slow first route before trying the next', async () => {
    // Direct is slow (3s). allorigins is fast (100ms). Sequentially this cost
    // 3s; hedged it should cost about the hedge delay plus 100ms.
    const calls = fakeFetch([
      { match: 'query1.finance.yahoo.com', delayMs: 3000 },
      { match: 'api.allorigins.win', delayMs: 100, body: '{"good":1}' },
    ]);
    const t0 = Date.now();
    const { text, proxied } = await fetchTextWithCorsFallback('https://query1.finance.yahoo.com/x', 5000, () => true, 200);
    const ms = Date.now() - t0;
    expect(text).toBe('{"good":1}');
    expect(proxied).toBe(true);
    expect(ms).toBeLessThan(1500);
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('starts the next route immediately on a failure, without waiting the hedge', async () => {
    const calls = fakeFetch([
      { match: 'query1.finance.yahoo.com', delayMs: 10, fail: true },
      { match: 'api.allorigins.win', delayMs: 50, body: 'OK' },
    ]);
    const t0 = Date.now();
    const { text } = await fetchTextWithCorsFallback('https://query1.finance.yahoo.com/x', 5000, () => true, 5000);
    expect(text).toBe('OK');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(calls.length).toBe(2);
  });

  it('remembers the winning route, so the next call skips the dead one', async () => {
    fakeFetch([
      { match: 'query1.finance.yahoo.com', delayMs: 10, fail: true },
      { match: 'api.allorigins.win', delayMs: 20, body: 'OK' },
    ]);
    await fetchTextWithCorsFallback('https://query1.finance.yahoo.com/a', 5000, () => true, 5000);
    const calls2 = fakeFetch([
      { match: 'query1.finance.yahoo.com', delayMs: 10, fail: true },
      { match: 'api.allorigins.win', delayMs: 20, body: 'OK2' },
    ]);
    const { text } = await fetchTextWithCorsFallback('https://query1.finance.yahoo.com/b', 5000, () => true, 5000);
    expect(text).toBe('OK2');
    // The remembered relay is tried FIRST, so the dead direct route is not hit.
    expect(calls2[0]).toContain('allorigins');
  });

  it('treats a 200-with-garbage body as a failure and moves on', async () => {
    fakeFetch([
      { match: 'query1.finance.yahoo.com', delayMs: 10, body: '<html>bot challenge</html>' },
      { match: 'api.allorigins.win', delayMs: 20, body: '{"real":1}' },
    ]);
    const { text } = await fetchTextWithCorsFallback(
      'https://query1.finance.yahoo.com/x', 5000, (t) => t.trimStart().startsWith('{'), 5000,
    );
    expect(text).toBe('{"real":1}');
  });

  it('rejects only after every route has failed', async () => {
    fakeFetch([{ match: 'nothing', delayMs: 1 }]);
    await expect(
      fetchTextWithCorsFallback('https://query1.finance.yahoo.com/x', 300, () => true, 50),
    ).rejects.toThrow();
  });
});
