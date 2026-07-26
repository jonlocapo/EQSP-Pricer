/**
 * marketdata.app option-chain fetcher — the keyless rung 1 of the vol
 * pipeline (see ./volPipeline).
 *
 * Two endpoints, both keyless and both confirmed, by a live probe with a
 * real free-tier account, to send `access-control-allow-origin: *`. So the
 * BROWSER can call them directly, with no CORS proxy:
 *
 *  - `GET /v1/options/expirations/{symbol}/` returns the list of listed
 *    expiry dates, ascending YYYY-MM-DD strings.
 *  - `GET /v1/options/chain/{symbol}/?expiration=YYYY-MM-DD` returns one
 *    expiry's full chain as COLUMN-ORIENTED parallel arrays — `strike`,
 *    `side`, `bid`, `ask`, `iv`, `underlyingPrice`, and so on, each an array
 *    indexed by contract, not one row object per contract. This module's
 *    job is to unzip those parallel arrays into the shared `OptionChain`
 *    row shape the rest of the pipeline already understands.
 *
 * The free tier serves DELAYED data and answers with HTTP 203, not 200, for
 * a delayed quote. `fetch`'s `res.ok` is true for 203, so nothing here
 * checks the status code directly — only the response body's `s` field,
 * which the API sets to `"ok"` on success and something else on failure.
 *
 * Coverage is US-listed names and ETFs only, the same limit every other
 * free chain source in this app carries.
 *
 * A deep in-the-money contract's implied vol is numerically unrecoverable
 * from a wide, illiquid quote: the price barely moves with vol, so the
 * solver that backs out iv from price has almost nothing to invert. A live
 * probe on AAPL, spot 333.48, showed exactly this — the 255-strike call
 * reported `iv: 0.0001` alongside a bid of 77.25, an obvious solver
 * failure, while the out-of-the-money side stayed clean and correctly
 * skewed (30.1% at 337.5, 33.3% at 305, 43.0% at 265, 70.5% at 205). So
 * every row is checked against a sane implied-vol band before it is kept.
 */
import { fetchWithTimeout } from './spotFetch';
import { yearsUntil, MIN_TENOR_YEARS, type ExpirySlice, type OptionChain, type OptionQuote } from './optionChain';

/** Below this, an implied vol is almost certainly a numerical artifact from
 * a deep in-the-money, wide-quote contract — see the AAPL 0.0001 case above. */
export const MIN_SANE_IV = 0.02;
/** Above this, an implied vol is not a plausible equity level either. */
export const MAX_SANE_IV = 3.0;

/** Fetch at most this many expiries, since each chain response is roughly
 * 30 kB and the endpoint is free and rate-limited. */
const MAX_EXPIRIES = 3;

interface ExpirationsResponse {
  s?: string;
  expirations?: string[];
}

/** Column-oriented: every field is an array, all arrays the same length,
 * indexed by contract. */
interface ChainResponse {
  s?: string;
  optionSymbol?: string[];
  side?: ('call' | 'put')[];
  strike?: number[];
  expiration?: number[]; // epoch seconds
  bid?: number[];
  ask?: number[];
  mid?: number[];
  last?: number[];
  iv?: number[];
  underlyingPrice?: number[];
}

/**
 * Picks up to `MAX_EXPIRIES` listed expiries from `expirations` that span
 * the tenor: the one nearest `tenorYears`, plus the ones nearest roughly a
 * third and two thirds of it. Skips anything inside `MIN_TENOR_YEARS` (10
 * days), the same rule `impliedFromChain` already enforces, and
 * deduplicates so a short tenor that collapses all three targets onto one
 * expiry still costs a single request.
 */
export function pickExpiries(expirations: string[], tenorYears: number, now = Date.now()): string[] {
  const candidates = expirations
    .map((expiry) => ({ expiry, tYears: yearsUntil(expiry, now) }))
    .filter((e) => e.tYears > MIN_TENOR_YEARS);
  if (candidates.length === 0) return [];

  const targets = [tenorYears / 3, (2 * tenorYears) / 3, tenorYears];
  const picked: string[] = [];
  for (const target of targets) {
    if (picked.length >= MAX_EXPIRIES) break;
    const nearest = candidates
      .filter((c) => !picked.includes(c.expiry))
      .sort((a, b) => Math.abs(a.tYears - target) - Math.abs(b.tYears - target))[0];
    if (nearest) picked.push(nearest.expiry);
  }
  return picked;
}

/** Unzips one expiry's column-oriented chain response into calls/puts,
 * strikes ascending, dropping any row whose strike or iv is unusable. */
function chainResponseToSlice(resp: ChainResponse): { calls: OptionQuote[]; puts: OptionQuote[] } {
  const n = resp.strike?.length ?? 0;
  const calls: OptionQuote[] = [];
  const puts: OptionQuote[] = [];
  for (let i = 0; i < n; i++) {
    const strike = resp.strike![i];
    if (!Number.isFinite(strike) || strike <= 0) continue;
    const iv = resp.iv?.[i];
    if (iv === undefined || !Number.isFinite(iv) || iv < MIN_SANE_IV || iv > MAX_SANE_IV) continue;
    const side = resp.side?.[i];
    if (side !== 'call' && side !== 'put') continue;

    const quote: OptionQuote = {
      strike,
      bid: resp.bid?.[i],
      ask: resp.ask?.[i],
      last: resp.last?.[i] ?? resp.mid?.[i],
      iv,
    };
    (side === 'call' ? calls : puts).push(quote);
  }
  calls.sort((a, b) => a.strike - b.strike);
  puts.sort((a, b) => a.strike - b.strike);
  return { calls, puts };
}

/**
 * Fetches an option chain for `symbol` from marketdata.app, needing no API
 * key, and converts it to the shared `OptionChain` shape. Builds a short
 * term structure of up to three expiries spanning `tenorYears`, rather than
 * a single expiry, because the surface-building rungs of the vol pipeline
 * want more than one tenor when it is available.
 *
 * `spot` is taken from the caller when given, otherwise from the chain
 * response's own `underlyingPrice` column.
 */
export async function fetchOptionChainMarketData(
  symbol: string,
  tenorYears: number,
  spot?: number,
): Promise<OptionChain> {
  const sym = symbol.trim().toUpperCase();
  if (!sym) throw new Error('Pick an underlying first');

  const expUrl = `https://api.marketdata.app/v1/options/expirations/${encodeURIComponent(sym)}/`;
  const expText = await fetchWithTimeout(expUrl, 8_000);
  const expParsed = JSON.parse(expText) as ExpirationsResponse;
  if (expParsed.s !== 'ok') {
    throw new Error(`marketdata.app has no option expiries for "${sym}"`);
  }
  const expirations = expParsed.expirations ?? [];
  if (expirations.length === 0) {
    throw new Error(`marketdata.app lists no option expiries for "${sym}"`);
  }

  const chosen = pickExpiries(expirations, tenorYears);
  if (chosen.length === 0) {
    throw new Error(`marketdata.app has no expiry for "${sym}" beyond 10 days out`);
  }

  const slices: ExpirySlice[] = [];
  let underlyingPrice: number | undefined;
  for (const expiry of chosen) {
    const chainUrl = `https://api.marketdata.app/v1/options/chain/${encodeURIComponent(sym)}/?expiration=${expiry}`;
    let chainText: string;
    try {
      chainText = await fetchWithTimeout(chainUrl, 8_000);
    } catch {
      continue; // One bad expiry request must not sink the whole chain.
    }
    let parsed: ChainResponse;
    try {
      parsed = JSON.parse(chainText) as ChainResponse;
    } catch {
      continue;
    }
    if (parsed.s !== 'ok') continue;

    if (underlyingPrice === undefined && parsed.underlyingPrice?.[0] !== undefined) {
      underlyingPrice = parsed.underlyingPrice[0];
    }
    const { calls, puts } = chainResponseToSlice(parsed);
    if (calls.length === 0 && puts.length === 0) continue;
    slices.push({ expiry, tYears: yearsUntil(expiry), calls, puts });
  }

  if (slices.length === 0) {
    throw new Error(`marketdata.app returned no usable (non-garbage-iv) option rows for "${sym}"`);
  }
  slices.sort((a, b) => a.tYears - b.tYears);

  const resolvedSpot = spot ?? underlyingPrice;
  if (!resolvedSpot || !(resolvedSpot > 0)) {
    throw new Error(`marketdata.app returned no usable spot for "${sym}"`);
  }

  return {
    symbol: sym,
    spot: resolvedSpot,
    slices,
    source: 'marketdata.app (delayed)',
  };
}
