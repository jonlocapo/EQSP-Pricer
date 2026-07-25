import { describe, expect, it } from 'vitest';
import { impliedFromChain, midPrice, type OptionChain } from '../src/services/optionChain';

/**
 * Pure tests for the source-agnostic chain derivation — no network. Chains are
 * built synthetically so put-call parity has an exactly known answer, which
 * makes the dividend-yield extraction verifiable rather than merely plausible.
 */

const spot = 100;
const rate = 0.03;

/**
 * Builds one expiry whose ATM call/put prices satisfy parity EXACTLY for the
 * given dividend yield: C - P = S*e^{-qT} - K*e^{-rT}. The absolute level of C
 * is arbitrary (parity only constrains the difference), so the derivation must
 * recover `q` regardless.
 */
function sliceForYield(expiry: string, tYears: number, q: number, iv: number, strike = 100) {
  const parity = spot * Math.exp(-q * tYears) - strike * Math.exp(-rate * tYears);
  const call = 8;
  const put = call - parity;
  return {
    expiry,
    tYears,
    calls: [{ strike, bid: call - 0.05, ask: call + 0.05, iv }],
    puts: [{ strike, bid: put - 0.05, ask: put + 0.05, iv }],
  };
}

function chainOf(slices: OptionChain['slices']): OptionChain {
  return { symbol: 'TEST', spot, slices, source: 'test' };
}

describe('midPrice', () => {
  it('prefers a two-sided mid, falls back to last, else null', () => {
    expect(midPrice({ strike: 100, bid: 4, ask: 6 })).toBe(5);
    expect(midPrice({ strike: 100, last: 7 })).toBe(7);
    // Crossed / one-sided quotes are not usable as a mid.
    expect(midPrice({ strike: 100, bid: 6, ask: 4, last: 7 })).toBe(7);
    expect(midPrice({ strike: 100, bid: 0, ask: 0 })).toBeNull();
    expect(midPrice({ strike: 100 })).toBeNull();
  });
});

describe('impliedFromChain', () => {
  it('recovers the dividend yield implied by parity, and the ATM vol', () => {
    const q = 0.018;
    const chain = chainOf([sliceForYield('2027-01-15', 1.0, q, 0.22)]);
    const r = impliedFromChain(chain, rate, 1.0);
    expect(r.divYield).toBeCloseTo(q, 6);
    expect(r.atmVol).toBeCloseTo(0.22, 10);
    expect(r.strike).toBe(100);
    expect(r.expiry).toBe('2027-01-15');
  });

  it('picks the expiry closest to the requested tenor', () => {
    const chain = chainOf([
      sliceForYield('2026-10-15', 0.25, 0.01, 0.3),
      sliceForYield('2027-07-15', 1.0, 0.02, 0.22),
      sliceForYield('2029-07-15', 3.0, 0.03, 0.19),
    ]);
    // tYears in the fixtures is explicit, so selection is deterministic.
    expect(impliedFromChain(chain, rate, 1.0).expiry).toBe('2027-07-15');
    expect(impliedFromChain(chain, rate, 3.0).expiry).toBe('2029-07-15');
  });

  it('skips an expiry whose parity yield is implausible instead of aborting', () => {
    // First (nearest) expiry is deliberately poisoned: a wildly mispriced pair
    // produces an absurd parity yield. The search must move on and use the
    // next expiry rather than failing outright — this used to throw.
    const poisoned = sliceForYield('2027-07-15', 1.0, 0.02, 0.22);
    poisoned.calls = [{ strike: 100, bid: 90, ask: 91, iv: 0.22 }];
    const chain = chainOf([poisoned, sliceForYield('2027-08-15', 1.1, 0.02, 0.21)]);

    const r = impliedFromChain(chain, rate, 1.0);
    expect(r.expiry).toBe('2027-08-15');
    expect(r.divYield).toBeCloseTo(0.02, 6);
  });

  it('skips an expiry with no two-sided quote, and reports why when nothing works', () => {
    const oneSided = {
      expiry: '2027-07-15',
      tYears: 1.0,
      calls: [{ strike: 100, bid: 4, ask: 5, iv: 0.2 }],
      puts: [], // no put at all -> not two-sided
    };
    expect(() => impliedFromChain(chainOf([oneSided]), rate, 1.0)).toThrow(/no quotable call\/put pair/i);
  });

  it('rejects a strike too far from spot rather than implying from it', () => {
    const farStrike = sliceForYield('2027-07-15', 1.0, 0.02, 0.22, 200);
    expect(() => impliedFromChain(chainOf([farStrike]), rate, 1.0)).toThrow(/>25% from spot/i);
  });

  it('ignores expiries inside 10 days', () => {
    const chain = chainOf([sliceForYield('2026-07-26', 5 / 365, 0.02, 0.22)]);
    expect(() => impliedFromChain(chain, rate, 1.0)).toThrow(/no listed expiry beyond 10 days/i);
  });

  it('requires a usable spot', () => {
    const chain: OptionChain = { symbol: 'TEST', spot: 0, slices: [], source: 'test' };
    expect(() => impliedFromChain(chain, rate, 1.0)).toThrow(/no usable spot/i);
  });
});
