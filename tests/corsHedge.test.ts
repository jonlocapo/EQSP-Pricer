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
    // Direct is slow (3s). The first relay (proxy.cors.sh) is fast (100ms).
    // Sequentially this cost 3s; hedged it should cost about the hedge delay
    // plus 100ms.
    const calls = fakeFetch([
      { match: 'query1.finance.yahoo.com', delayMs: 3000 },
      { match: 'proxy.cors.sh', delayMs: 100, body: '{"good":1}' },
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
      { match: 'proxy.cors.sh', delayMs: 50, body: 'OK' },
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
      { match: 'proxy.cors.sh', delayMs: 20, body: 'OK' },
    ]);
    await fetchTextWithCorsFallback('https://query1.finance.yahoo.com/a', 5000, () => true, 5000);
    const calls2 = fakeFetch([
      { match: 'query1.finance.yahoo.com', delayMs: 10, fail: true },
      { match: 'proxy.cors.sh', delayMs: 20, body: 'OK2' },
    ]);
    const { text } = await fetchTextWithCorsFallback('https://query1.finance.yahoo.com/b', 5000, () => true, 5000);
    expect(text).toBe('OK2');
    // The remembered relay is tried FIRST, so the dead direct route is not hit.
    expect(calls2[0]).toContain('cors.sh');
  });

  it('treats a 200-with-garbage body as a failure and moves on', async () => {
    fakeFetch([
      { match: 'query1.finance.yahoo.com', delayMs: 10, body: '<html>bot challenge</html>' },
      { match: 'proxy.cors.sh', delayMs: 20, body: '{"real":1}' },
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

  it('unwraps the allorigins /get JSON envelope before validating the body', async () => {
    // allorigins' /get endpoint returns the target INSIDE a JSON envelope
    // ({ "contents": "<the target body>" }), so consumers that validate the
    // raw body (e.g. Yahoo's "starts with {" check) would reject it. The
    // transport must unwrap it first. cors.sh and codetabs pass through
    // untouched, so they must fail here to force the call down to allorigins.
    const calls = fakeFetch([
      { match: 'query1.finance.yahoo.com', delayMs: 10, fail: true },
      { match: 'proxy.cors.sh', delayMs: 10, fail: true },
      { match: 'api.allorigins.win', delayMs: 20, body: '{"contents":"{\\"chart\\":{\\"ok\\":1}}"}' },
    ]);
    const { text, proxied } = await fetchTextWithCorsFallback(
      'https://query1.finance.yahoo.com/x',
      5000,
      (t) => t.trimStart().startsWith('{'),
      5000,
    );
    expect(proxied).toBe(true);
    expect(text).toBe('{"chart":{"ok":1}}');
    expect(calls.some((u) => u.includes('api.allorigins.win/get'))).toBe(true);
  });

  it('leaves a non-allorigins relay body untouched', async () => {
    fakeFetch([
      { match: 'query1.finance.yahoo.com', delayMs: 10, fail: true },
      { match: 'proxy.cors.sh', delayMs: 20, body: '{"direct":1}' },
    ]);
    const { text } = await fetchTextWithCorsFallback(
      'https://query1.finance.yahoo.com/x',
      5000,
      (t) => t.trimStart().startsWith('{'),
      5000,
    );
    expect(text).toBe('{"direct":1}');
  });
});
