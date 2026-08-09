/** One line of the market-panel fetch log. Shared between the primary
 * underlying's fetch (`MarketPanel.tsx`) and the basket-leg fetch
 * (`basketFetch.ts`), so both write the log in the same shape. */
export interface FetchLine {
  kind: 'ok' | 'err' | 'info';
  msg: string;
  /** Compact form used when rolling successful fetches into one summary line. */
  short?: string;
}

/** Render an elapsed time for a fetch log line: milliseconds under a second,
 * one decimal of seconds above it, e.g. "412ms" or "3.2s". */
export function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}
