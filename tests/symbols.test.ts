import { describe, expect, it } from 'vitest';
import { isIndexSymbol, normalizeQuoteCurrency, toCboeSymbol, toStooqSymbol } from '../src/services/symbols';

describe('toCboeSymbol', () => {
  it('maps Yahoo index symbols to the roots CBOE actually lists', () => {
    // The bug this covers: ticker search returns ^GSPC for the S&P 500, which
    // used to map to _GSPC — a root CBOE does not serve — so picking the index
    // from search silently broke the option fetch while the hand-typed default
    // ^SPX happened to work.
    expect(toCboeSymbol('^GSPC')).toBe('_SPX');
    expect(toCboeSymbol('^SPX')).toBe('_SPX');
    expect(toCboeSymbol('^DJI')).toBe('_DJX');
    expect(toCboeSymbol('^IXIC')).toBe('_NDX');
    expect(toCboeSymbol('^RUT')).toBe('_RUT');
    expect(toCboeSymbol('^VIX')).toBe('_VIX');
  });

  it('rejects indices CBOE has no chain for, with a clear message', () => {
    expect(() => toCboeSymbol('^FTSE')).toThrow(/does not list options on index/i);
  });

  it('folds US class shares to their dotless root instead of rejecting them', () => {
    // BRK.B is US-listed and CBOE lists it as BRKB; it used to be thrown out
    // by a blanket "contains a dot" check.
    expect(toCboeSymbol('BRK.B')).toBe('BRKB');
    expect(toCboeSymbol('BF.B')).toBe('BFB');
  });

  it('still rejects genuinely non-US listings', () => {
    expect(() => toCboeSymbol('BMW.DE')).toThrow(/only lists US options/i);
    expect(() => toCboeSymbol('AAPL.MX')).toThrow(/only lists US options/i);
  });

  it('passes plain US tickers through, uppercased', () => {
    expect(toCboeSymbol('aapl')).toBe('AAPL');
    expect(toCboeSymbol(' BA ')).toBe('BA');
  });

  it('requires a symbol', () => {
    expect(() => toCboeSymbol('')).toThrow(/pick an underlying/i);
  });
});

describe('normalizeQuoteCurrency', () => {
  it('converts minor-unit quotes to their major currency with a divisor', () => {
    // Yahoo returns GBp (pence) for many London lines. Left alone, the note
    // currency comparison always saw a quanto mismatch against GBP and the
    // spot was 100x too large.
    expect(normalizeQuoteCurrency('GBp')).toEqual({ currency: 'GBP', priceDivisor: 100 });
    expect(normalizeQuoteCurrency('GBX')).toEqual({ currency: 'GBP', priceDivisor: 100 });
    expect(normalizeQuoteCurrency('ZAc')).toEqual({ currency: 'ZAR', priceDivisor: 100 });
  });

  it('passes ordinary currencies through unscaled', () => {
    expect(normalizeQuoteCurrency('usd')).toEqual({ currency: 'USD', priceDivisor: 1 });
    expect(normalizeQuoteCurrency('EUR')).toEqual({ currency: 'EUR', priceDivisor: 1 });
  });

  it('handles a missing currency', () => {
    expect(normalizeQuoteCurrency(undefined)).toEqual({ currency: undefined, priceDivisor: 1 });
    expect(normalizeQuoteCurrency('')).toEqual({ currency: undefined, priceDivisor: 1 });
  });
});

describe('toStooqSymbol / isIndexSymbol', () => {
  it('keeps existing behaviour', () => {
    expect(toStooqSymbol('AAPL')).toBe('aapl.us');
    expect(toStooqSymbol('BMW.DE')).toBe('bmw.de');
    expect(toStooqSymbol('^SPX')).toBe('^spx');
    expect(isIndexSymbol('^SPX')).toBe(true);
    expect(isIndexSymbol('AAPL')).toBe(false);
  });
});
