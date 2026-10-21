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

interface ImpliedResult {
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
  // CBOE MOVED THIS API. `cdn.cboe.com` now answers with a Cloudflare 307 to
  // `cdn-api.cboe.com`. A CORS relay hands back the 307's HTML page instead
  // of following it, the JSON check below rejects that page, and the rung
  // fails without a word. Every underlying then fell through to the realized
  // fallback, which ran SAP at 57.6% ATM against a market of 37.6%. Request
  // the new host directly, so no relay ever sees a redirect.
  const url = `https://cdn-api.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(symbol)}.json`;
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
  /** One source, end to end: fetch the chain, then imply from it. A source
   * that answers with a chain the implier cannot use counts as a failure, so
   * the race below does not settle on it. */
  const attempt = async (load: () => Promise<OptionChain>): Promise<ImpliedResult> => {
    const chain = await load();
    const implied = impliedFromChain(chain, rate, tenorYears);
    return {
      ...implied,
      source: chain.source,
      // Parity is exact only for European-style options. Listed single-name
      // options are American.
      approximate: !isIndexSymbol(yahooSymbol),
      chain,
    };
  };

  // RACE THE SOURCES, do not queue them. Yahoo v7 used to run first and CBOE
  // only after it. Yahoo v7 now needs a session crumb this app cannot get, so
  // it times out at 6 seconds on EVERY call. CBOE therefore started at about
  // 7.5 seconds, long after the chain budget in volPipeline.ts had expired,
  // and its correct answer was thrown away. Measured: CBOE alone gives SAP
  // 37.2% and SPY 19.2% at 2 years, matching the listed market, while the
  // fallback the pipeline used instead gave SAP 57.6%.
  //
  // Racing makes a dead source cost nothing. The first source to produce a
  // usable implied vol wins; the others run to completion and are discarded.
  try {
    return await Promise.any([
      attempt(() => fetchOptionChainCboe(yahooSymbol)),
      attempt(() => fetchOptionChainYahoo(yahooSymbol, tenorYears)),
    ]);
  } catch (e) {
    const reasons =
      e instanceof AggregateError
        ? e.errors.map((x) => (x instanceof Error ? x.message : String(x)))
        : [e instanceof Error ? e.message : String(e)];
    throw new Error(
      `Could not imply vol/div yield from any option source. Enter them manually. ${reasons.join('; ')}`,
    );
  }
}
