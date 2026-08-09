/**
 * Source-agnostic option-chain model plus a Yahoo Finance chain fetcher.
 *
 * Two consumers:
 *  - `impliedFromChain` derives a forward dividend yield, via put-call
 *    parity, and an ATM volatility for a target tenor. This is what the
 *    market panel needs.
 *  - The full strike ladders are what a volatility skew or surface needs.
 *    So the chain is kept whole, rather than collapsed to a single ATM
 *    number.
 *
 * Yahoo is preferred over CBOE because it takes the SAME symbol the app
 * already stores, with no per-source symbol mapping to get wrong, and
 * reports implied vols directly. Coverage is still predominantly US-listed
 * options. So a European single name may legitimately have no chain
 * anywhere. That case is reported, not silently papered over.
 */
import { fetchTextWithCorsFallback } from './spotFetch';

export interface OptionQuote {
  strike: number;
  bid?: number;
  ask?: number;
  last?: number;
  /** Implied volatility as a decimal (0.25 = 25%), when the source gives one. */
  iv?: number;
}

export interface ExpirySlice {
  /** YYYY-MM-DD */
  expiry: string;
  tYears: number;
  /** Ascending by strike. */
  calls: OptionQuote[];
  puts: OptionQuote[];
}

export interface OptionChain {
  symbol: string;
  spot: number;
  /** Ascending by tYears. */
  slices: ExpirySlice[];
  source: string;
}

interface ImpliedFromChain {
  divYield: number;
  atmVol: number;
  spot: number;
  expiry: string;
  strike: number;
  tYears: number;
}

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;
/** Anything expiring sooner than this is too close-dated to imply from. */
export const MIN_TENOR_YEARS = 10 / 365;

export function midPrice(q: OptionQuote): number | null {
  if (q.bid !== undefined && q.ask !== undefined && q.bid > 0 && q.ask > 0 && q.ask >= q.bid) {
    return (q.bid + q.ask) / 2;
  }
  if (q.last !== undefined && q.last > 0) return q.last;
  return null;
}

export function yearsUntil(expiry: string, now = Date.now()): number {
  // 21:00Z ~ US close, matching how the expiry date is quoted.
  return (new Date(`${expiry}T21:00:00Z`).getTime() - now) / MS_PER_YEAR;
}

/**
 * Forward dividend yield from put-call parity at the most ATM two-sided strike,
 * plus that strike's implied vol, taken from the listed expiry closest to
 * `tenorYears`:
 *
 *   C − P = S·e^{−qT} − K·e^{−rT}   ⇒   q = −ln((C − P + K·e^{−rT}) / S) / T
 *
 * This is exact for European-style options, such as indices. It is an
 * approximation for American-style single names, which callers should
 * label as such.
 *
 * The function judges each expiry independently. It skips an unusable one,
 * rather than aborting the whole search, and reports the last rejection
 * reason, so a failure explains itself.
 */
export function impliedFromChain(chain: OptionChain, rate: number, tenorYears: number): ImpliedFromChain {
  const { spot } = chain;
  if (!(spot > 0)) throw new Error(`${chain.source} returned no usable spot for "${chain.symbol}"`);

  const candidates = chain.slices
    .filter((s) => s.tYears > MIN_TENOR_YEARS)
    .sort((a, b) => Math.abs(a.tYears - tenorYears) - Math.abs(b.tYears - tenorYears));
  if (candidates.length === 0) {
    throw new Error(`No listed expiry beyond 10 days for "${chain.symbol}", so vol cannot be implied`);
  }

  let lastReject = '';
  for (const slice of candidates.slice(0, 6)) {
    const puts = new Map(slice.puts.map((p) => [p.strike, p]));
    const twoSided = slice.calls
      .filter((c) => {
        const p = puts.get(c.strike);
        return !!p && midPrice(c) !== null && midPrice(p) !== null;
      })
      .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));

    if (twoSided.length === 0) {
      lastReject = `no quotable call/put pair at ${slice.expiry}`;
      continue;
    }
    const call = twoSided[0];
    const put = puts.get(call.strike)!;
    const strike = call.strike;
    if (Math.abs(strike - spot) / spot > 0.25) {
      lastReject = `nearest two-sided strike ${strike} is >25% from spot at ${slice.expiry}`;
      continue;
    }

    const c = midPrice(call)!;
    const p = midPrice(put)!;
    const q = -Math.log((c - p + strike * Math.exp(-rate * slice.tYears)) / spot) / slice.tYears;

    const ivs = [call.iv, put.iv].filter((v): v is number => v !== undefined && v > 0.005 && v < 3);
    if (ivs.length === 0) {
      lastReject = `no plausible implied vol at ${slice.expiry}`;
      continue;
    }
    const atmVol = ivs.reduce((a, b) => a + b, 0) / ivs.length;

    if (!Number.isFinite(q) || q < -0.05 || q > 0.2) {
      lastReject = `parity gave an implausible dividend yield (${(q * 100).toFixed(2)}%) at K=${strike}, ${slice.expiry}`;
      continue;
    }

    return { divYield: q, atmVol, spot, expiry: slice.expiry, strike, tYears: slice.tYears };
  }

  throw new Error(
    `No liquid ATM call/put pair near the tenor for "${chain.symbol}"${lastReject ? ` (last attempt: ${lastReject})` : ''}`,
  );
}

// ---------------------------------------------------------------------------
// Yahoo Finance chain
// ---------------------------------------------------------------------------

interface YahooOption {
  strike?: number;
  bid?: number;
  ask?: number;
  lastPrice?: number;
  impliedVolatility?: number;
}

interface YahooOptionsResult {
  underlyingSymbol?: string;
  expirationDates?: number[];
  quote?: { regularMarketPrice?: number };
  options?: { expirationDate?: number; calls?: YahooOption[]; puts?: YahooOption[] }[];
}

function toQuotes(raw: YahooOption[] | undefined): OptionQuote[] {
  return (raw ?? [])
    .filter((o): o is YahooOption & { strike: number } => typeof o.strike === 'number' && o.strike > 0)
    .map((o) => ({
      strike: o.strike,
      bid: o.bid,
      ask: o.ask,
      last: o.lastPrice,
      iv: o.impliedVolatility,
    }))
    .sort((a, b) => a.strike - b.strike);
}

function isoDateFromUnix(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

async function fetchYahooOptions(symbol: string, date?: number): Promise<{ result: YahooOptionsResult; proxied: boolean }> {
  const base = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`;
  const url = date === undefined ? base : `${base}?date=${date}`;
  const { text, proxied } = await fetchTextWithCorsFallback(url, 6_000, (t) => t.trimStart().startsWith('{'));
  const parsed = JSON.parse(text) as {
    optionChain?: { result?: YahooOptionsResult[]; error?: { description?: string } | null };
  };
  const result = parsed.optionChain?.result?.[0];
  if (!result) {
    throw new Error(parsed.optionChain?.error?.description ?? `Yahoo returned no option chain for "${symbol}"`);
  }
  return { result, proxied };
}

/**
 * Fetches up to `maxExpiries` expiries nearest `tenorYears`. Yahoo returns
 * only one expiry's ladders per request, plus the full list of expiry
 * dates. So the function requests the nearest expiries individually and
 * merges them.
 */
export async function fetchOptionChainYahoo(
  yahooSymbol: string,
  tenorYears: number,
  maxExpiries = 3,
): Promise<OptionChain> {
  const symbol = yahooSymbol.trim();
  if (!symbol) throw new Error('Pick an underlying first');

  const first = await fetchYahooOptions(symbol);
  const spot = first.result.quote?.regularMarketPrice;
  if (!spot || !(spot > 0)) {
    throw new Error(`Yahoo returned no spot for "${symbol}", so its chain cannot be used`);
  }

  const expiryDates = (first.result.expirationDates ?? []).filter((d) => typeof d === 'number');
  if (expiryDates.length === 0) {
    throw new Error(`Yahoo lists no option expiries for "${symbol}"`);
  }

  // The ladders already returned belong to one expiry. Index them, so that
  // expiry is not re-requested.
  const slices = new Map<string, ExpirySlice>();
  for (const block of first.result.options ?? []) {
    if (block.expirationDate === undefined) continue;
    const expiry = isoDateFromUnix(block.expirationDate);
    slices.set(expiry, {
      expiry,
      tYears: yearsUntil(expiry),
      calls: toQuotes(block.calls),
      puts: toQuotes(block.puts),
    });
  }

  const wanted = expiryDates
    .map((d) => ({ d, expiry: isoDateFromUnix(d), tYears: yearsUntil(isoDateFromUnix(d)) }))
    .filter((e) => e.tYears > MIN_TENOR_YEARS)
    .sort((a, b) => Math.abs(a.tYears - tenorYears) - Math.abs(b.tYears - tenorYears))
    .slice(0, Math.max(1, maxExpiries));

  let proxied = first.proxied;
  for (const w of wanted) {
    if (slices.has(w.expiry)) continue;
    try {
      const { result, proxied: p } = await fetchYahooOptions(symbol, w.d);
      proxied = proxied || p;
      for (const block of result.options ?? []) {
        const expiry = block.expirationDate === undefined ? w.expiry : isoDateFromUnix(block.expirationDate);
        slices.set(expiry, {
          expiry,
          tYears: yearsUntil(expiry),
          calls: toQuotes(block.calls),
          puts: toQuotes(block.puts),
        });
      }
    } catch {
      // One unavailable expiry should not sink the whole chain. The caller
      // fails only if NO usable expiry survives.
    }
  }

  const ordered = [...slices.values()].sort((a, b) => a.tYears - b.tYears);
  if (ordered.length === 0) {
    throw new Error(`Yahoo returned no usable option expiries for "${symbol}"`);
  }

  return {
    symbol,
    spot,
    slices: ordered,
    source: proxied ? 'Yahoo options (proxied)' : 'Yahoo options',
  };
}
