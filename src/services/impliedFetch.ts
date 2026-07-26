/**
 * Market-implied dividend yield and ATM volatility from free option chains.
 *
 * Two sources are tried in order:
 *  1. Yahoo — takes the same symbol the app already stores, so there is no
 *     per-source symbol mapping to get wrong, and it reports implied vols
 *     directly.
 *  2. CBOE delayed quotes, the original source, kept as a fallback. It is
 *     US-listed only and needs its own symbol roots (see toCboeSymbol).
 *
 * The derivation itself, parity dividend yield plus ATM vol, is shared and
 * lives in ./optionChain. So both sources produce identical results from
 * identical quotes.
 *
 * Fails loudly. If neither source yields a usable chain, the error names
 * what each one said, so the caller can surface it instead of silently
 * falling back.
 */
import { fetchTextWithCorsFallback } from './spotFetch';
import { isIndexSymbol, toCboeSymbol } from './symbols';
import {
  fetchOptionChainYahoo,
  impliedFromChain,
  yearsUntil,
  type ExpirySlice,
  type OptionChain,
  type OptionQuote,
} from './optionChain';

export interface ImpliedResult {
  divYield: number;
  atmVol: number;
  spot: number;
  expiry: string; // YYYY-MM-DD
  strike: number;
  tYears: number;
  source: string;
  /** True when parity is only approximate (American-style options). */
  approximate: boolean;
  /** The chain the result came from, kept for volatility-surface use. */
  chain: OptionChain;
}

interface CboeOption {
  option: string;
  bid: number;
  ask: number;
  iv: number;
  last_trade_price: number | null;
}

const OPT_RE = /^([A-Z_]+?)(\d{6})([CP])(\d{8})$/;

/** Fetches CBOE's delayed chain and converts it to the shared chain shape. */
async function fetchOptionChainCboe(yahooSymbol: string): Promise<OptionChain> {
  const symbol = toCboeSymbol(yahooSymbol);
  const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(symbol)}.json`;
  let text: string;
  let proxied: boolean;
  try {
    ({ text, proxied } = await fetchTextWithCorsFallback(url, 6_000, (t) => t.trimStart().startsWith('{')));
  } catch {
    throw new Error(`CBOE has no option chain for "${symbol}" (or the request was blocked)`);
  }

  const parsed = JSON.parse(text) as {
    data?: { current_price?: number; close?: number; options?: CboeOption[] };
  };
  const spot = parsed.data?.current_price ?? parsed.data?.close;
  const options = parsed.data?.options ?? [];
  if (!spot || !(spot > 0) || options.length === 0) {
    throw new Error(`CBOE returned an empty chain for "${symbol}"`);
  }

  const byExpiry = new Map<string, { calls: OptionQuote[]; puts: OptionQuote[] }>();
  for (const o of options) {
    const m = OPT_RE.exec(o.option);
    if (!m) continue;
    const [, , yymmdd, cp, strikeRaw] = m;
    const expiry = `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
    const quote: OptionQuote = {
      strike: Number(strikeRaw) / 1000,
      bid: o.bid,
      ask: o.ask,
      last: o.last_trade_price ?? undefined,
      iv: o.iv,
    };
    let entry = byExpiry.get(expiry);
    if (!entry) byExpiry.set(expiry, (entry = { calls: [], puts: [] }));
    if (cp === 'C') entry.calls.push(quote);
    else entry.puts.push(quote);
  }

  const slices: ExpirySlice[] = [...byExpiry.entries()]
    .map(([expiry, e]) => ({
      expiry,
      tYears: yearsUntil(expiry),
      calls: e.calls.sort((a, b) => a.strike - b.strike),
      puts: e.puts.sort((a, b) => a.strike - b.strike),
    }))
    .sort((a, b) => a.tYears - b.tYears);

  return {
    symbol,
    spot,
    slices,
    source: proxied ? 'CBOE delayed (proxied)' : 'CBOE delayed',
  };
}

/** `yahooSymbol` is Yahoo-style (BA, ^SPX, BMW.DE). */
export async function fetchImpliedFromOptions(
  yahooSymbol: string,
  tenorYears: number,
  rate: number,
): Promise<ImpliedResult> {
  const reasons: string[] = [];

  for (const load of [
    () => fetchOptionChainYahoo(yahooSymbol, tenorYears),
    () => fetchOptionChainCboe(yahooSymbol),
  ]) {
    let chain: OptionChain;
    try {
      chain = await load();
    } catch (e) {
      reasons.push(e instanceof Error ? e.message : String(e));
      continue;
    }
    try {
      const implied = impliedFromChain(chain, rate, tenorYears);
      return {
        ...implied,
        source: chain.source,
        // Parity is exact only for European-style options. Listed single-name
        // options are American.
        approximate: !isIndexSymbol(yahooSymbol),
        chain,
      };
    } catch (e) {
      reasons.push(e instanceof Error ? e.message : String(e));
    }
  }

  throw new Error(
    `Could not imply vol/div yield from any option source — enter them manually. ${reasons.join('; ')}`,
  );
}
