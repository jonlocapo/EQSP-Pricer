/**
 * Single entry point for "get me a volatility surface for this underlying",
 * trying progressively cheaper and less trustworthy sources until one
 * works. Every rung catches and falls through, so one dead source never
 * takes the whole pipeline down.
 *
 * The ladder, best to worst. Every rung is keyless: none needs an API key.
 *  1. marketdata.app's option chain. Real implied vols, up to three
 *     expiries, no CORS proxy needed, and no key. The free tier serves
 *     delayed data. Deep-in-the-money rows are filtered out, because their
 *     implied vol is numerically unrecoverable (see ./marketDataApp).
 *  2. The existing keyless chain path (Yahoo v7, then CBOE). Real implied
 *     vols when it works. Yahoo's v7 endpoint is unreliable without session
 *     cookies, and CBOE is US-only.
 *  3. A listed volatility index for THIS underlying (VIX, VSTOXX, VDAX...),
 *     used to scale the realized-vol term structure up to an implied-like
 *     level. The index itself is genuine 30-day implied vol, and it needs no
 *     option chain and no key. It is the most valuable free anchor.
 *  4. No index for this name, but the volatility risk premium is largely a
 *     systematic, market-wide effect. Borrow the ratio measured on ^VIX vs
 *     ^GSPC realized vol and apply it to this name's realized moments.
 *  5. Plain realized vol, unscaled. No volatility risk premium, so it
 *     typically sits below traded implied levels.
 *  6. No price history at all, but a listed vol index still gives a genuine
 *     implied LEVEL. Flat smile at that level.
 *  7. Every source failed. A flat surface at the volatility already in the
 *     panel. This rung cannot fail, so the pipeline never throws and the
 *     pricer always has a usable surface.
 */
import { buildVolSurface, volAtPctOfSpot, type VolSurface } from '../model/volSurface';
import { buildRealizedSurface } from '../model/realizedSurface';
import { applyVrp, nearestAnchorTerm, vrpRatio } from '../model/vrp';
import { fetchOptionChainMarketData } from './marketDataApp';
import { impliedFromChain } from './optionChain';
import { fetchImpliedFromOptions } from './impliedFetch';
import { fetchRealizedStats } from './marketFetch';
import { fetchRealizedVolStats, type RealizedVolStatsResult } from './realizedVolFetch';
import { fetchVolIndexLevel, volIndexSymbolFor } from './volIndex';

export type VolSourceKind =
  | 'chain-free-marketdata'
  | 'chain-free'
  | 'vol-index'
  | 'realized-scaled'
  | 'realized'
  | 'vol-index-flat'
  | 'entered';

export interface VolPipelineResult {
  surface: VolSurface;
  /** Decimal, at the requested tenor. */
  atmVol: number;
  /** Only present when a chain gave one. The realized-derived rungs leave the
   * caller's existing dividend yield untouched. */
  divYield?: number;
  kind: VolSourceKind;
  /** Short human string for the UI, e.g. "marketdata.app (delayed)". */
  label: string;
  /** Caveat for the UI, e.g. "Realized moments scaled by a 1.24x VSTOXX/realized premium". */
  note?: string;
}

export interface VolPipelineArgs {
  /** Yahoo-style underlying symbol. */
  symbol: string;
  spot: number;
  tenorYears: number;
  rate: number;
  /**
   * The volatility currently in the market panel, decimal. The last rung
   * returns a flat surface at this level, so the pricer always has a usable
   * surface even when every network source fails. Pass the value the user can
   * already see, never a hardcoded guess.
   */
  fallbackVol: number;
  /** Overall deadline for the whole ladder. Defaults to DEFAULT_BUDGET_MS. */
  budgetMs?: number;
}

/**
 * A flat surface at one volatility level. `buildRealizedSurface` with zero
 * skew and zero excess kurtosis produces exactly this, so the flat rungs reuse
 * the tested smile builder instead of assembling a surface by hand.
 */
function flatSurface(spot: number, vol: number, tYears: number, source: string): VolSurface {
  return buildRealizedSurface(spot, { terms: [{ tYears, vol }], skewDaily: 0, excessKurtDaily: 0 }, source);
}

/**
 * The market-wide VIX/realized ratio, cached in module scope so a session
 * pricing several underlyings pays for the ^VIX and ^GSPC fetch once, not
 * once per underlying. A failed attempt is NOT cached. It clears itself, so the
 * next underlying can retry: a transient fetch failure must not permanently
 * disable rung 4 for the rest of the session.
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

/**
 * The whole ladder's time budget. Seven rungs, several of which retry through
 * four public CORS relays, add up: a measured all-sources-fail run took 153
 * seconds before this cap existed, which is far too long to leave a user
 * watching a spinner. On expiry the pipeline returns the entered-vol rung, and
 * the user can fetch again or type a level.
 *
 * The losing ladder is NOT cancelled, because the sources it calls have no
 * abort handle here. Its result is simply discarded. Callers already guard
 * against a late write with their own generation check.
 */
const DEFAULT_BUDGET_MS = 12_000;

/**
 * The terminal rung, computed without any network call so it can never fail.
 * Both the normal end of the ladder and the budget expiry return this.
 */
function enteredVolRung(spot: number, tenorYears: number, fallbackVol: number): VolPipelineResult {
  // The 20% floor applies only when the panel itself holds no usable vol, for
  // example a first load that failed before any fetch landed. It is a
  // placeholder that keeps the engine running, and the label says so.
  const entered = fallbackVol > 0 ? fallbackVol : 0.2;
  return {
    surface: flatSurface(spot, entered, tenorYears, 'entered vol'),
    atmVol: entered,
    kind: 'entered',
    label: fallbackVol > 0 ? 'entered vol (flat)' : 'placeholder 20% (flat)',
    note: 'Every market vol source failed. Enter a volatility manually to price on a level you trust.',
  };
}

/**
 * Runs the ladder under a time budget. Whichever finishes first wins, so a
 * stalled source costs the budget rather than the sum of every timeout below
 * it.
 */
export async function fetchVolPipeline(args: VolPipelineArgs): Promise<VolPipelineResult> {
  const fallback = enteredVolRung(args.spot, args.tenorYears, args.fallbackVol);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<VolPipelineResult>((resolve) => {
    timer = setTimeout(() => resolve(fallback), args.budgetMs ?? DEFAULT_BUDGET_MS);
  });
  try {
    return await Promise.race([runLadder(args), budget]);
  } catch {
    // A throw anywhere in the ladder still lands on a usable surface.
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

async function runLadder(args: VolPipelineArgs): Promise<VolPipelineResult> {
  const { symbol, spot, tenorYears, rate, fallbackVol } = args;

  // Rung 1: marketdata.app chain, keyless.
  try {
    const chain = await fetchOptionChainMarketData(symbol, tenorYears, spot);
    const surface = buildVolSurface(chain);
    const implied = impliedFromChain(chain, rate, tenorYears);
    return {
      surface,
      atmVol: implied.atmVol,
      divYield: implied.divYield,
      kind: 'chain-free-marketdata',
      label: chain.source,
    };
  } catch {
    // Fall through. A dead or empty chain must not sink the pipeline.
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

  const ownIndexSymbol = volIndexSymbolFor(symbol);

  // Rungs 3, 4 and 5 need this underlying's realized moments. A failure here
  // used to throw out of the whole pipeline, which left the pricer with no
  // surface at all whenever the daily-close fetch was rate-limited or blocked.
  // It now falls through to the flat rungs, which need no price history.
  //
  // The OHLC path (Yang-Zhang level + GARCH(1,1) term structure — see
  // ./realizedVolFetch.ts) is tried first, because it is the genuine model:
  // range-based instead of close-only, and mean-reverting instead of four
  // overlapping trailing windows. `fetchRealizedStats` (close-only,
  // trailing windows) is the fallback when the OHLC fetch itself fails, for
  // example a source that serves close but not open/high/low.
  let realized: RealizedVolStatsResult | Awaited<ReturnType<typeof fetchRealizedStats>> | undefined;
  try {
    realized = await fetchRealizedVolStats(symbol);
  } catch {
    try {
      realized = await fetchRealizedStats(symbol);
    } catch {
      realized = undefined;
    }
  }
  const modelLabel = realized && 'modelLabel' in realized ? realized.modelLabel : 'close-to-close (trailing windows)';

  if (realized) {
    // Rung 3: a listed vol index for THIS underlying.
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
          label: `${idx.symbol}-scaled realized (${modelLabel})`,
          note: `Realized moments (${modelLabel}) scaled by a ${ratio.toFixed(2)}x ${idx.symbol}/realized premium`,
        };
      } catch {
        // Fall through to the market-wide ratio.
      }
    }

    // Rung 4: no index for this name, so borrow the broad-market VIX/realized
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
        label: `VIX-scaled realized (${modelLabel})`,
        // Rung 3 either found no index for this name or could not fetch the
        // one it found. Both land here, so the note names the substitute
        // rather than claiming a reason it cannot know.
        note: `Realized moments (${modelLabel}) scaled by the broad-market ${marketRatio.toFixed(2)}x VIX/realized premium, because no vol index reading was available for "${symbol}"`,
      };
    } catch {
      // Fall through to plain realized, the last rung that uses history.
    }

    // Rung 5: plain realized vol, unscaled.
    const surface = buildRealizedSurface(spot, realized, `${realized.source} surface`);
    return {
      surface,
      atmVol: volAtPctOfSpot(surface, 100, tenorYears),
      kind: 'realized',
      label: `${realized.source} (${modelLabel})`,
      note: 'Realized vol carries no volatility risk premium, so it typically sits below traded implied levels',
    };
  }

  // Rung 6: no price history reached us, but a listed vol index still gives a
  // genuine implied LEVEL for this underlying. There is no history to carry a
  // shape, so the smile is flat. A flat surface at the right level beats a
  // skewed surface at the wrong one.
  if (ownIndexSymbol) {
    try {
      const idx = await fetchVolIndexLevel(ownIndexSymbol);
      return {
        surface: flatSurface(spot, idx.vol, tenorYears, `${idx.symbol} flat`),
        atmVol: idx.vol,
        kind: 'vol-index-flat',
        label: `${idx.symbol} implied`,
        note: `No price history available, so the smile is flat at the ${idx.symbol} level`,
      };
    } catch {
      // Fall through to the entered vol.
    }
  }

  // Rung 7: every source failed. Keep the volatility the user can already see
  // in the panel and build a flat surface at that level, so pricing still works
  // and nothing is silently invented.
  return enteredVolRung(spot, tenorYears, fallbackVol);
}
