/**
 * Market-implied dividend yield and ATM volatility from CBOE's free delayed
 * option chains (no auth; CORS-proxy fallback in the browser).
 *
 * Forward dividend yield via put-call parity at the ATM strike of the expiry
 * nearest the trade tenor:  C − P = S·e^{−qT} − K·e^{−rT}  ⇒
 * q = −ln((C − P + K·e^{−rT}) / S) / T.
 * Exact for European-style options (indices, e.g. SPX); an approximation for
 * American-style single names — callers should label it as such.
 *
 * Fails loudly: every unusable condition throws with a specific reason; the
 * caller must surface the message, never fall back silently.
 */
import { fetchTextWithCorsFallback } from './spotFetch';

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
}

interface CboeOption {
  option: string;
  bid: number;
  ask: number;
  iv: number;
  last_trade_price: number | null;
}

const OPT_RE = /^([A-Z_]+?)(\d{6})([CP])(\d{8})$/;

function midPrice(o: CboeOption): number | null {
  if (o.bid > 0 && o.ask > 0 && o.ask >= o.bid) return (o.bid + o.ask) / 2;
  if (o.last_trade_price && o.last_trade_price > 0) return o.last_trade_price;
  return null;
}

/** Map a UI underlying name to a CBOE chain symbol. */
export function toCboeSymbol(underlyingName: string, assetType: 'share' | 'index'): string {
  const cleaned = underlyingName
    .replace(/\s+index$/i, '')
    .replace(/^[\^_]/, '')
    .trim()
    .toUpperCase();
  if (!cleaned) throw new Error('Enter an underlying ticker first');
  return assetType === 'index' ? `_${cleaned}` : cleaned;
}

export async function fetchImpliedFromOptions(
  underlyingName: string,
  assetType: 'share' | 'index',
  tenorYears: number,
  rate: number,
): Promise<ImpliedResult> {
  const symbol = toCboeSymbol(underlyingName, assetType);
  const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(symbol)}.json`;
  let text: string;
  let proxied: boolean;
  try {
    ({ text, proxied } = await fetchTextWithCorsFallback(url, 10_000, (t) => t.trimStart().startsWith('{')));
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

  // Group by expiry, then strike.
  const byExpiry = new Map<string, Map<number, { call?: CboeOption; put?: CboeOption }>>();
  for (const o of options) {
    const m = OPT_RE.exec(o.option);
    if (!m) continue;
    const [, , yymmdd, cp, strikeRaw] = m;
    const expiry = `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
    const strike = Number(strikeRaw) / 1000;
    let strikes = byExpiry.get(expiry);
    if (!strikes) byExpiry.set(expiry, (strikes = new Map()));
    let pair = strikes.get(strike);
    if (!pair) strikes.set(strike, (pair = {}));
    if (cp === 'C') pair.call = o;
    else pair.put = o;
  }

  const now = Date.now();
  const msPerYear = 365.25 * 24 * 3600 * 1000;
  const candidates = [...byExpiry.keys()]
    .map((e) => ({ expiry: e, tYears: (new Date(`${e}T21:00:00Z`).getTime() - now) / msPerYear }))
    .filter((c) => c.tYears > 10 / 365)
    .sort((a, b) => Math.abs(a.tYears - tenorYears) - Math.abs(b.tYears - tenorYears));
  if (candidates.length === 0) throw new Error('No listed expiry beyond 10 days — cannot imply');

  for (const { expiry, tYears } of candidates.slice(0, 3)) {
    const strikes = byExpiry.get(expiry)!;
    const atmStrikes = [...strikes.keys()]
      .filter((k) => {
        const p = strikes.get(k)!;
        return p.call && p.put && midPrice(p.call) !== null && midPrice(p.put) !== null;
      })
      .sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot));
    if (atmStrikes.length === 0) continue;
    const strike = atmStrikes[0];
    if (Math.abs(strike - spot) / spot > 0.1) continue; // no liquid strike near ATM
    const pair = strikes.get(strike)!;
    const c = midPrice(pair.call!)!;
    const p = midPrice(pair.put!)!;

    const q = -Math.log((c - p + strike * Math.exp(-rate * tYears)) / spot) / tYears;
    const ivC = pair.call!.iv;
    const ivP = pair.put!.iv;
    const ivs = [ivC, ivP].filter((v) => v > 0.005 && v < 3);
    if (ivs.length === 0) continue;
    const atmVol = ivs.reduce((a, b) => a + b, 0) / ivs.length;

    if (!Number.isFinite(q) || q < -0.05 || q > 0.2) {
      throw new Error(
        `Parity gave an implausible dividend yield (${(q * 100).toFixed(2)}%) at K=${strike}, ${expiry} — chain too illiquid, enter manually`,
      );
    }
    return {
      divYield: q,
      atmVol,
      spot,
      expiry,
      strike,
      tYears,
      source: proxied ? 'CBOE delayed (proxied)' : 'CBOE delayed',
      approximate: assetType === 'share',
    };
  }
  throw new Error('No liquid ATM call/put pair near the tenor — enter div yield and vol manually');
}
