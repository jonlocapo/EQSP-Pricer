import { describe, expect, it } from 'vitest';
import { alphaVantageChainToOptionChain, type AlphaVantageRow } from '../src/services/alphaVantage';

/**
 * Pure conversion tests — no network. Alpha Vantage's `HISTORICAL_OPTIONS`
 * response is a flat array of contract rows, all fields as STRINGS, matching
 * a live probe of the real endpoint. These tests pin: numeric-string
 * parsing, grouping by expiration, ascending-strike sort within each side,
 * and that a malformed row is skipped rather than corrupting the chain.
 */

const SPOT = 190;

function row(overrides: Partial<AlphaVantageRow>): AlphaVantageRow {
  return {
    contractID: 'IBM250117C00190000',
    symbol: 'IBM',
    expiration: '2027-01-15',
    strike: '190.00',
    type: 'call',
    last: '8.50',
    mark: '8.60',
    bid: '8.40',
    ask: '8.80',
    implied_volatility: '0.2200',
    ...overrides,
  };
}

describe('alphaVantageChainToOptionChain', () => {
  it('converts a real-shaped row set into the shared OptionChain, strikes ascending', () => {
    const rows: AlphaVantageRow[] = [
      row({ strike: '200.00', type: 'call', implied_volatility: '0.25' }),
      row({ strike: '180.00', type: 'call', implied_volatility: '0.21' }),
      row({ strike: '190.00', type: 'call', implied_volatility: '0.22' }),
      row({ strike: '190.00', type: 'put', implied_volatility: '0.23' }),
      row({ strike: '180.00', type: 'put', implied_volatility: '0.27' }),
    ];
    const chain = alphaVantageChainToOptionChain(rows, 'IBM', SPOT);

    expect(chain.symbol).toBe('IBM');
    expect(chain.spot).toBe(SPOT);
    expect(chain.slices).toHaveLength(1);

    const slice = chain.slices[0];
    expect(slice.expiry).toBe('2027-01-15');
    expect(slice.calls.map((c) => c.strike)).toEqual([180, 190, 200]);
    expect(slice.puts.map((p) => p.strike)).toEqual([180, 190]);
    expect(slice.calls[0].iv).toBeCloseTo(0.21, 10);
    expect(slice.puts[1].iv).toBeCloseTo(0.23, 10);
    // bid/ask/last are parsed through as numbers, not left as strings.
    expect(slice.calls[1].bid).toBeCloseTo(8.4, 10);
    expect(slice.calls[1].last).toBeCloseTo(8.5, 10);
  });

  it('groups rows into separate slices by expiration, sorted ascending by tYears', () => {
    const rows: AlphaVantageRow[] = [
      row({ expiration: '2028-06-16', strike: '190', type: 'call' }),
      row({ expiration: '2027-01-15', strike: '190', type: 'call' }),
      row({ expiration: '2027-06-18', strike: '190', type: 'call' }),
    ];
    const chain = alphaVantageChainToOptionChain(rows, 'IBM', SPOT);
    expect(chain.slices.map((s) => s.expiry)).toEqual(['2027-01-15', '2027-06-18', '2028-06-16']);
  });

  it('skips a row with a non-finite or non-positive strike', () => {
    const rows: AlphaVantageRow[] = [
      row({ strike: 'not-a-number' }),
      row({ strike: '0' }),
      row({ strike: '-5' }),
      row({ strike: '190', type: 'call' }),
    ];
    const chain = alphaVantageChainToOptionChain(rows, 'IBM', SPOT);
    expect(chain.slices).toHaveLength(1);
    expect(chain.slices[0].calls).toHaveLength(1);
    expect(chain.slices[0].calls[0].strike).toBe(190);
  });

  it('skips a row with a non-positive or missing implied vol', () => {
    const rows: AlphaVantageRow[] = [
      row({ strike: '185', implied_volatility: '0' }),
      row({ strike: '186', implied_volatility: undefined }),
      row({ strike: '187', implied_volatility: '-0.1' }),
      row({ strike: '190', implied_volatility: '0.2' }),
    ];
    const chain = alphaVantageChainToOptionChain(rows, 'IBM', SPOT);
    expect(chain.slices[0].calls.map((c) => c.strike)).toEqual([190]);
  });

  it('skips a row whose type is neither "call" nor "put"', () => {
    const rows: AlphaVantageRow[] = [row({ type: 'straddle' }), row({ strike: '190', type: 'put' })];
    const chain = alphaVantageChainToOptionChain(rows, 'IBM', SPOT);
    expect(chain.slices[0].calls).toHaveLength(0);
    expect(chain.slices[0].puts).toHaveLength(1);
  });

  it('skips a row with no expiration', () => {
    const rows: AlphaVantageRow[] = [row({ expiration: undefined }), row({ strike: '190' })];
    const chain = alphaVantageChainToOptionChain(rows, 'IBM', SPOT);
    expect(chain.slices).toHaveLength(1);
  });

  it('falls back to mark when last is absent', () => {
    const rows: AlphaVantageRow[] = [row({ last: undefined, mark: '9.10' })];
    const chain = alphaVantageChainToOptionChain(rows, 'IBM', SPOT);
    expect(chain.slices[0].calls[0].last).toBeCloseTo(9.1, 10);
  });

  it('produces no slices from an all-bad row set', () => {
    const rows: AlphaVantageRow[] = [row({ strike: 'x' }), row({ implied_volatility: '0' })];
    const chain = alphaVantageChainToOptionChain(rows, 'IBM', SPOT);
    expect(chain.slices).toHaveLength(0);
  });
});
