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
 *
 * The DIVIDEND YIELD is measured separately, and independently of which rung
 * wins. Rungs 1 and 2 imply it from the chain by put-call parity. The rest
 * measure it from price history, as the gap between a total-return series and a
 * price series (see ./divYieldFetch). So a note no longer prices on a stale
 * typed yield just because no option chain was reachable.
 */
import { buildVolSurface, volAtPctOfSpot, type VolSurface } from '../model/volSurface';
import { buildRealizedSurface } from '../model/realizedSurface';
import { buildSkewSurface, effectiveBeta1y } from '../model/skewSurface';
import { applyVrp, nearestAnchorTerm, vrpRatio } from '../model/vrp';
import { fetchOptionChainMarketData } from './marketDataApp';
import { impliedFromChain } from './optionChain';
import { fetchImpliedFromOptions } from './impliedFetch';
import { fetchRealizedStats } from './marketFetch';
import { fetchRealizedVolStats, type RealizedVolStatsResult } from './realizedVolFetch';
import { fetchVolIndexLevel, volIndexSymbolFor } from './volIndex';
import { divYieldFromChartPayload, fetchRealizedDivYield } from './divYieldFetch';
import { isIndexSymbol } from './symbols';

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
  /** From put-call parity when a chain gave one, otherwise MEASURED from price
   * history (see ./divYieldFetch). Absent only when neither was possible, in
   * which case the caller keeps whatever yield it already had. */
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
 * The bound on rungs 1 and 2 TOGETHER, the two that chase option chains.
 *
 * Without a bound of their own they starve the rungs that work. Measured worst
 * case: rung 1 allows two 8 second fetches, and rung 2 tries Yahoo v7 then CBOE,
 * each hedging four routes at 700 ms intervals with a 6 second timeout, so about
 * 8 seconds each. That is up to 24 seconds for the two, which exceeds the whole
 * ladder's budget, so the budget expired inside rung 2 and the pipeline returned
 * the entered-vol rung even when price history was perfectly reachable. A chain
 * that has not answered in this long is not going to.
 */
const CHAIN_BUDGET_MS = 3_000;

/** Resolves to `undefined` if `work` has not finished within `ms`. The losing
 * work is not cancelled, because these sources have no abort handle here; its
 * result is simply discarded. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

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
  const { symbol } = args;

  // INVARIANT: the realized rungs must always get a chance to run, whatever the
  // chain rungs do. They read different hosts, so serialising them only added
  // their latencies together. Start the price-history fetch here and await it
  // after the chain rungs, so by then it is already in flight or finished.
  //
  // The `catch` is attached immediately, not later: nothing awaits this promise
  // for several seconds, and an early rejection would otherwise surface as an
  // unhandled rejection.
  const realizedP: Promise<RealizedVolStatsResult | Awaited<ReturnType<typeof fetchRealizedStats>> | undefined> =
    fetchRealizedVolStats(symbol)
      .catch(() => fetchRealizedStats(symbol))
      .catch(() => undefined);

  const chainResult = await withDeadline(chainRungs(args), CHAIN_BUDGET_MS);
  if (chainResult) return chainResult;

  return realizedRungs(args, await realizedP);
}

/**
 * Rungs 1 and 2: a real option chain, which beats any model when it answers.
 * Resolves to `undefined` when neither source produced one.
 */
async function chainRungs(args: VolPipelineArgs): Promise<VolPipelineResult | undefined> {
  const { symbol, spot, tenorYears, rate } = args;

  // Rung 1: marketdata.app chain, keyless.
  try {
    const chain = await fetchOptionChainMarketData(symbol, tenorYears, spot);
    // Parity FIRST: the dividend yield it derives is an INPUT the vol
    // inversion needs (see buildVolSurface's opts), not just an output
    // reported alongside it. Order matters.
    const implied = impliedFromChain(chain, rate, tenorYears);
    const surface = buildVolSurface(chain, { rate, divYield: implied.divYield });
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
    // fetchImpliedFromOptions already runs impliedFromChain internally to
    // get r.divYield (parity on prices), before this ever touches
    // buildVolSurface — see impliedFetch.ts. Reuse it rather than deriving
    // it twice.
    const r = await fetchImpliedFromOptions(symbol, tenorYears, rate);
    const surface = buildVolSurface(r.chain, { rate, divYield: r.divYield });
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

  return undefined;
}

/**
 * Rungs 3 to 7: the model built from price history, then the flat backstops.
 *
 * `realized` is whatever the price-history fetch produced, started before the
 * chain rungs ran. Undefined means no history was reachable, which leaves only
 * the flat rungs. The OHLC path (Yang-Zhang level plus GARCH(1,1) term
 * structure, see ./realizedVolFetch.ts) is preferred over the close-only
 * trailing windows, and that preference is expressed where the promise is
 * built.
 */
async function realizedRungs(
  args: VolPipelineArgs,
  realized: RealizedVolStatsResult | Awaited<ReturnType<typeof fetchRealizedStats>> | undefined,
): Promise<VolPipelineResult> {
  const { symbol, spot, tenorYears, rate, fallbackVol } = args;
  const ownIndexSymbol = volIndexSymbolFor(symbol);

  const modelLabel = realized && 'modelLabel' in realized ? realized.modelLabel : 'close-to-close (trailing windows)';

  // A dividend yield measured from price history, for the rungs that have no
  // chain to imply one from. The yield enters the drift as
  // `rate - divYield - borrow`, so leaving it at a stale typed value biases the
  // forward and every price with it. Undefined when it cannot be measured,
  // which leaves the caller's existing yield untouched rather than replacing it
  // with a guess.
  let measuredDivYield: number | undefined;
  let divYieldNote: string | undefined;
  try {
    // Prefer the payload the vol model already fetched. It is the SAME two
    // years of the SAME symbol, and the adjusted close the yield needs rides in
    // it, so refetching would spend a request on identical data. Fall back to a
    // dedicated fetch only when there is no payload, which is the index case,
    // where the yield genuinely needs a second symbol.
    const payload = realized && 'payload' in realized ? realized.payload : undefined;
    const dy =
      payload !== undefined && !isIndexSymbol(symbol)
        ? divYieldFromChartPayload(symbol, payload)
        : await fetchRealizedDivYield(symbol);
    measuredDivYield = dy.divYield;
    divYieldNote = `div ${(dy.divYield * 100).toFixed(2)}% realized over ${dy.years.toFixed(1)}y (${dy.source})`;
  } catch {
    // No total-return series for this underlying. Keep the entered yield.
  }
  /**
   * The smile for a realized-derived rung.
   *
   * The LEVEL and the TERM STRUCTURE stay exactly as the rung computed them,
   * from Yang-Zhang plus GARCH with the risk-premium scaling. Only the SHAPE
   * changes: it now comes from a direct slope in log-moneyness decaying as the
   * square root of maturity, rather than from realized third and fourth
   * moments through a Gram-Charlier expansion.
   *
   * Realized skewness is roughly an order of magnitude shallower than the
   * risk-neutral skewness options actually price, and the wing it produced was
   * therefore far too flat exactly where knock-in barriers sit. So this MOVES
   * PRICES on any note with a barrier, and it moves them in the direction the
   * economics say: a steeper downside wing means a more valuable short put and
   * a higher solved coupon.
   */
  const smileFor = (terms: { tYears: number; vol: number }[], source: string) =>
    buildSkewSurface(
      spot,
      terms,
      effectiveBeta1y(isIndexSymbol(symbol)),
      rate,
      measuredDivYield ?? 0,
      source,
    );

  /** Appends the dividend provenance to a rung's note, so a MEASURED yield is
   * never applied silently. */
  const withDivNote = (note: string) => (divYieldNote ? `${note} · ${divYieldNote}` : note);

  if (realized) {
    // Rung 3: a listed vol index for THIS underlying.
    if (ownIndexSymbol) {
      try {
        const idx = await fetchVolIndexLevel(ownIndexSymbol);
        const anchor = nearestAnchorTerm(realized.terms);
        const ratio = vrpRatio(idx.vol, anchor.vol);
        const scaled = applyVrp(realized, ratio);
        const surface = smileFor(scaled.terms, `${idx.symbol}-scaled realized`);
        return {
          surface,
          atmVol: volAtPctOfSpot(surface, 100, tenorYears),
          divYield: measuredDivYield,
        kind: 'vol-index',
          label: `${idx.symbol}-scaled realized (${modelLabel})`,
          note: withDivNote(`Realized moments (${modelLabel}) scaled by a ${ratio.toFixed(2)}x ${idx.symbol}/realized premium`),
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
      const surface = smileFor(scaled.terms, 'VIX-scaled realized (market-wide premium)');
      return {
        surface,
        atmVol: volAtPctOfSpot(surface, 100, tenorYears),
        divYield: measuredDivYield,
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
    const surface = smileFor(realized.terms, `${realized.source} surface`);
    return {
      surface,
      atmVol: volAtPctOfSpot(surface, 100, tenorYears),
      divYield: measuredDivYield,
    kind: 'realized',
      label: `${realized.source} (${modelLabel})`,
      note: withDivNote('Realized vol carries no volatility risk premium, so it typically sits below traded implied levels'),
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
        divYield: measuredDivYield,
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
