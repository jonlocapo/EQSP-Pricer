import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRefRate } from '../src/services/marketFetch';
import { __resetPreferredRoutes } from '../src/services/spotFetch';

/**
 * A relay that is rate-limited often answers HTTP 200 with its OWN error body
 * rather than refusing the connection. The response check inside
 * `fetchTextWithCorsFallback` decides which route WINS the hedged race, so an
 * unchecked route lets that error body win and abort the routes still in
 * flight. The reference-rate fetches used to pass no check at all.
 *
 * No wrong rate could ever result, because both parsers reject a body they
 * cannot read. The cost is availability: a fetch that fails when a working
 * relay was mid-answer.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});
beforeEach(() => __resetPreferredRoutes());

/** The ECB csvdata shape, which every ECB parser here reads by column name. */
const ECB_CSV = 'KEY,FREQ,REF_AREA,TIME_PERIOD,OBS_VALUE\nEST.B.WT,B,U2,2026-08-07,2.185';
/** What a rate-limited relay sends: 200, valid JSON, useless. It contains a
 * comma and does not start with '<', so the old CSV check accepted it. */
const RELAY_ERROR = '{"error":"Edge: Too Many Requests","code":429}';
const SOFR_JSON = '{"refRates":[{"effectiveDate":"2026-08-06","percentRate":4.32}]}';

/** Every route answers after the same short delay, so the ORDER the routes are
 * tried in is what decides the winner, exactly as in the real hedge. */
function routeBodies(bodies: string[]) {
  let i = 0;
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise((resolve, reject) => {
      const body = bodies[Math.min(i++, bodies.length - 1)];
      const t = setTimeout(() => resolve({ ok: true, text: async () => body } as Response), 5);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      });
    })) as unknown as typeof fetch;
}

describe('reference rate fetches survive a relay that answers 200 with junk', () => {
  it('does not let a relay error body win the EUR race', async () => {
    // First route returns the relay's error, a later one has the real fixing.
    routeBodies([RELAY_ERROR, ECB_CSV]);
    const r = await fetchRefRate('EUR');
    expect(r.rate).toBeCloseTo(0.02185, 9);
    expect(r.asOf).toBe('2026-08-07');
  });

  it('does not let a relay error body win the USD race', async () => {
    routeBodies([RELAY_ERROR, SOFR_JSON]);
    const r = await fetchRefRate('USD');
    expect(r.rate).toBeCloseTo(0.0432, 9);
  });

  it('fails rather than reporting a rate when every route answers junk', async () => {
    // A rate that cannot be read must not become a number. The entered value
    // stays in force instead.
    routeBodies([RELAY_ERROR]);
    await expect(fetchRefRate('EUR')).rejects.toThrow();
    __resetPreferredRoutes();
    await expect(fetchRefRate('USD')).rejects.toThrow();
  });

  it('still accepts a genuine payload on the very first route', async () => {
    // The check must not be so tight that it rejects the real thing.
    routeBodies([ECB_CSV]);
    await expect(fetchRefRate('EUR')).resolves.toMatchObject({ asOf: '2026-08-07' });
  });
});
