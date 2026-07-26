/**
 * Single entry point for "get me a volatility surface for this underlying",
 * trying progressively cheaper and less trustworthy sources until one
 * works. Every rung catches and falls through — one dead source must never
 * take the whole pipeline down.
 *
 * The ladder, best to worst:
 *  1. Alpha Vantage's full option chain (needs a free API key) — real
 *     implied vols, every strike, no CORS proxy needed.
 *  2. The existing keyless chain path (Yahoo v7, then CBOE) — real implied
 *     vols when it works, but Yahoo's v7 endpoint is unreliable without
 *     session cookies and CBOE is US-only.
 *  3. A listed volatility index for THIS underlying (VIX, VSTOXX, VDAX...),
 *     used to scale the realized-vol term structure up to an implied-like
 *     level. The index itself is genuine 30-day implied vol, needing no
 *     option chain and no key — the single most valuable free anchor.
 *  4. No index for this name, but the volatility risk premium is largely a
 *     systematic, market-wide effect. Borrow the ratio measured on ^VIX vs
 *     ^GSPC realized vol and apply it to this name's realized moments.
 *  5. Plain realized vol, unscaled — no volatility risk premium, so it
 *     typically sits below traded implied levels. The historical fallback,
 *     kept as the last resort it always should have been.
 */
import { buildVolSurface, volAtPctOfSpot, type VolSurface } from '../model/volSurface';
import { buildRealizedSurface } from '../model/realizedSurface';
import { applyVrp, nearestAnchorTerm, vrpRatio } from '../model/vrp';
import { fetchAlphaVantageChain } from './alphaVantage';
import { impliedFromChain } from './optionChain';
import { fetchImpliedFromOptions } from './impliedFetch';
import { fetchRealizedStats } from './marketFetch';
import { fetchVolIndexLevel, volIndexSymbolFor } from './volIndex';

export type VolSourceKind = 'chain-keyed' | 'chain-free' | 'vol-index' | 'realized-scaled' | 'realized';

export interface VolPipelineResult {
  surface: VolSurface;
  /** Decimal, at the requested tenor. */
  atmVol: number;
  /** Only present when a chain gave one — realized-derived rungs leave the
   * caller's existing dividend yield untouched. */
  divYield?: number;
  kind: VolSourceKind;
  /** Short human string for the UI, e.g. "Alpha Vantage chain". */
  label: string;
  /** Honest caveat, e.g. "Realized moments scaled by a 1.24x VSTOXX/realized premium". */
  note?: string;
}

export interface VolPipelineArgs {
  /** Yahoo-style underlying symbol. */
  symbol: string;
  spot: number;
  tenorYears: number;
  rate: number;
  /** Alpha Vantage API key, optional — rung 1 is skipped without one. */
  apiKey?: string;
}

/**
 * The market-wide VIX/realized ratio, cached in module scope so a session
 * pricing several underlyings pays for the ^VIX and ^GSPC fetch once, not
 * once per underlying. A failed attempt is NOT cached — it clears itself so
 * the next underlying can retry, since a transient fetch failure should not
 * permanently disable rung 4 for the rest of the session.
 */
let marketRatioCache: Promise<number> | undefined;

async function getMarketVrpRatio(): Promise<number> {
  if (!marketRatioCache) {
    marketRatioCache = (async () => {
      const [idx, realizedMarket] = await Promise.all([
        fetchVolIndexLevel('^VIX'),
        fetchRealizedStats('^GSPC'),
      ]);
      const anchor = nearestAnchorTerm(realizedMarket.terms);
      return vrpRatio(idx.vol, anchor.vol);
    })();
    marketRatioCache.catch(() => {
      marketRatioCache = undefined;
    });
  }
  return marketRatioCache;
}

export async function fetchVolPipeline(args: VolPipelineArgs): Promise<VolPipelineResult> {
  const { symbol, spot, tenorYears, rate, apiKey } = args;

  // Rung 1: Alpha Vantage chain, only if a key was supplied.
  if (apiKey && apiKey.trim()) {
    try {
      const chain = await fetchAlphaVantageChain(symbol, apiKey, spot);
      const surface = buildVolSurface(chain);
      const implied = impliedFromChain(chain, rate, tenorYears);
      return {
        surface,
        atmVol: implied.atmVol,
        divYield: implied.divYield,
        kind: 'chain-keyed',
        label: 'Alpha Vantage chain',
      };
    } catch {
      // Fall through — a dead or rate-limited key must not sink the pipeline.
    }
  }

  // Rung 2: the existing keyless chain path (Yahoo v7, then CBOE).
  try {
    const r = await fetchImpliedFromOptions(symbol, tenorYears, rate);
    const surface = buildVolSurface(r.chain);
    return {
      surface,
      atmVol: r.atmVol,
      divYield: r.divYield,
      kind: 'chain-free',
      label: r.source,
      note: r.approximate ? 'Dividend yield is approximate (American-style parity)' : undefined,
    };
  } catch {
    // Fall through to the realized-based rungs.
  }

  // Rungs 3-5 all need this underlying's realized moments. Without them
  // nothing further is possible, so let this one throw upward.
  const realized = await fetchRealizedStats(symbol);

  // Rung 3: a listed vol index for THIS underlying.
  const ownIndexSymbol = volIndexSymbolFor(symbol);
  if (ownIndexSymbol) {
    try {
      const idx = await fetchVolIndexLevel(ownIndexSymbol);
      const anchor = nearestAnchorTerm(realized.terms);
      const ratio = vrpRatio(idx.vol, anchor.vol);
      const scaled = applyVrp(realized, ratio);
      const surface = buildRealizedSurface(spot, scaled, `${idx.symbol}-scaled realized`);
      return {
        surface,
        atmVol: volAtPctOfSpot(surface, 100, tenorYears),
        kind: 'vol-index',
        label: `${idx.symbol}-scaled realized`,
        note: `Realized moments scaled by a ${ratio.toFixed(2)}x ${idx.symbol}/realized premium`,
      };
    } catch {
      // Fall through to the market-wide ratio.
    }
  }

  // Rung 4: no index for this name — borrow the broad-market VIX/realized
  // ratio and apply it here. The premium is largely systematic, so this
  // beats guessing a constant.
  try {
    const marketRatio = await getMarketVrpRatio();
    const scaled = applyVrp(realized, marketRatio);
    const surface = buildRealizedSurface(spot, scaled, 'VIX-scaled realized (market-wide premium)');
    return {
      surface,
      atmVol: volAtPctOfSpot(surface, 100, tenorYears),
      kind: 'realized-scaled',
      label: 'VIX-scaled realized',
      note: `No listed vol index for "${symbol}" — applied the broad-market ${marketRatio.toFixed(2)}x VIX/realized premium instead`,
    };
  } catch {
    // Fall through to plain realized — the last resort.
  }

  // Rung 5: plain realized vol, unscaled.
  const surface = buildRealizedSurface(spot, realized, `${realized.source} surface`);
  return {
    surface,
    atmVol: volAtPctOfSpot(surface, 100, tenorYears),
    kind: 'realized',
    label: realized.source,
    note: 'Realized vol carries no volatility risk premium — it typically sits below traded implied levels',
  };
}
