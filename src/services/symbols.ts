/**
 * The app stores underlyings as Yahoo-Finance-style symbols, picked via the
 * ticker search: "BA", "^SPX", "BMW.DE". Each data source needs its own
 * convention. These mappers centralize the translation.
 */

export const isIndexSymbol = (symbol: string): boolean => symbol.startsWith('^');

/**
 * Yahoo reports some listings in a minor unit. London lines come back as
 * "GBp" (pence), not "GBP". Left alone, that both breaks currency
 * comparison — a pence-quoted name always looks like a quanto mismatch
 * against GBP — and leaves the quoted price 100 times too large. Returns
 * the ISO currency, together with the divisor needed to convert a quoted
 * price into it.
 */
export function normalizeQuoteCurrency(raw?: string): { currency?: string; priceDivisor: number } {
  const t = raw?.trim();
  if (!t) return { currency: undefined, priceDivisor: 1 };
  switch (t) {
    case 'GBp':
    case 'GBX':
      return { currency: 'GBP', priceDivisor: 100 };
    case 'ZAc':
      return { currency: 'ZAR', priceDivisor: 100 };
    case 'ILA':
      return { currency: 'ILS', priceDivisor: 100 };
    default:
      return { currency: t.toUpperCase(), priceDivisor: 1 };
  }
}

/** Stooq: lowercase; bare US tickers get ".us"; indices keep the caret. */
export function toStooqSymbol(symbol: string): string {
  const s = symbol.trim().toLowerCase();
  if (!s) throw new Error('Pick an underlying first');
  if (s.startsWith('^')) return s;
  return s.includes('.') ? s : `${s}.us`;
}

/**
 * Index tickers whose CBOE option-root differs from the Yahoo symbol.
 * Without these, the mapping silently produces a root CBOE does not serve.
 * Most importantly, `^GSPC` is exactly what the ticker search returns for
 * the S&P 500. So picking the index from search used to break the option
 * fetch, while the hand-typed default `^SPX` happened to work.
 */
const CBOE_INDEX_ROOTS: Record<string, string> = {
  GSPC: 'SPX', // S&P 500 — Yahoo's ^GSPC, CBOE's _SPX
  SPX: 'SPX',
  DJI: 'DJX', // Dow Jones
  IXIC: 'NDX', // Nasdaq Composite -> CBOE lists Nasdaq-100
  NDX: 'NDX',
  RUT: 'RUT', // Russell 2000
  VIX: 'VIX',
};

/**
 * Non-US suffixes are genuinely unavailable on CBOE, which lists US
 * options only. A dot does NOT by itself mean non-US, though. US class
 * shares like BRK.B are listed, under a dotless root (BRKB).
 */
const US_CLASS_SHARE_RE = /^[A-Z]+\.[A-Z]$/;

/** CBOE delayed chains: US-listed only; indices use an underscore prefix. */
export function toCboeSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  if (!s) throw new Error('Pick an underlying first');
  if (s.startsWith('^')) {
    const bare = s.slice(1);
    const root = CBOE_INDEX_ROOTS[bare];
    if (!root) {
      throw new Error(`CBOE does not list options on index "${s}"`);
    }
    return `_${root}`;
  }
  // US class shares (BRK.B -> BRKB) are listed. Other dotted symbols are
  // foreign listings and genuinely have no CBOE chain.
  if (US_CLASS_SHARE_RE.test(s)) return s.replace('.', '');
  if (s.includes('.')) {
    throw new Error(`CBOE only lists US options, so there is no chain for "${s}"`);
  }
  return s;
}
