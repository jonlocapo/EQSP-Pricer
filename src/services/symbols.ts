/**
 * The app stores underlyings as Yahoo-Finance-style symbols (picked via the
 * ticker search): "BA", "^SPX", "BMW.DE". Each data source needs its own
 * convention; these mappers centralize the translation.
 */

export const isIndexSymbol = (symbol: string): boolean => symbol.startsWith('^');

/** Stooq: lowercase; bare US tickers get ".us"; indices keep the caret. */
export function toStooqSymbol(symbol: string): string {
  const s = symbol.trim().toLowerCase();
  if (!s) throw new Error('Pick an underlying first');
  if (s.startsWith('^')) return s;
  return s.includes('.') ? s : `${s}.us`;
}

/** CBOE delayed chains: US-listed only; indices use an underscore prefix. */
export function toCboeSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  if (!s) throw new Error('Pick an underlying first');
  if (s.startsWith('^')) return `_${s.slice(1)}`;
  if (s.includes('.')) {
    throw new Error(`CBOE only lists US options — no chain for "${s}"`);
  }
  return s;
}
