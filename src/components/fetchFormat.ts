/** One line of the market-panel fetch log. Shared between the primary
 * underlying's fetch (`MarketPanel.tsx`) and the basket-leg fetch
 * (`basketFetch.ts`), so both write the log in the same shape. */
export interface FetchLine {
  kind: 'ok' | 'err' | 'info';
  msg: string;
  /** Compact form used when rolling successful fetches into one summary line. */
  short?: string;
  /**
   * Which input this line describes, so the panel can put it on THAT field's
   * information dot instead of stacking every outcome into one block of prose
   * under the fetch button.
   *
   * A reader who wants to know where the volatility came from is looking at
   * the volatility field, not at a log. `'run'` is the catch-all for lines
   * about the fetch itself — the request count, the route summary — which
   * belong to no single input and sit on the Fetch button.
   */
  field?: FetchField;
}

/** The inputs a fetch line can describe. */
export type FetchField = 'spot' | 'rate' | 'vol' | 'dividend' | 'correlation' | 'quanto' | 'run';

/** Render an elapsed time for a fetch log line: milliseconds under a second,
 * one decimal of seconds above it, e.g. "412ms" or "3.2s". */
export function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** Every line tagged for one field, joined into a single tooltip. Returns
 * undefined when nothing was reported for it, so the caller can leave the dot
 * off rather than show an empty one. */
export function tooltipFor(lines: FetchLine[], field: FetchField): string | undefined {
  const hit = lines.filter((l) => l.field === field);
  return hit.length > 0 ? hit.map((l) => l.msg).join('\n') : undefined;
}

/** The worst outcome reported for a field, so its dot can be coloured: an
 * error outranks an info, which outranks a success. */
export function worstKind(lines: FetchLine[], field: FetchField): FetchLine['kind'] | undefined {
  const hit = lines.filter((l) => l.field === field);
  if (hit.length === 0) return undefined;
  if (hit.some((l) => l.kind === 'err')) return 'err';
  if (hit.some((l) => l.kind === 'info')) return 'info';
  return 'ok';
}
