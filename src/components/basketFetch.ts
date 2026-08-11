/**
 * Live-data fetch for the worst-of basket's EXTRA legs (index 1 and up in
 * the leg list; the primary leg fetches through `fetchLiveData` in
 * `MarketPanel.tsx`). Before this module existed, "Fetch live" only ever
 * populated the primary leg, and every extra leg kept whatever volatility
 * and dividend yield the user had typed by hand — which defeats the point
 * of running the volatility ladder at all on a worst-of note.
 *
 * All legs fetch CONCURRENTLY with `Promise.all`, each against its own
 * shorter time budget, so three extra legs cost roughly one ladder run, not
 * three run one after another.
 */
import { useMarketStore, DEFAULT_LEG_CORRELATION, type BasketLegState, type CorrelationSource } from '../state/marketStore';
import { fetchVolPipeline } from '../services/volPipeline';
import { realizedCorrelationMatrix } from '../services/marketFetch';
import { applyCorrelationRiskPremium, CORRELATION_RISK_PREMIUM } from '../model/correlation';
import { fetchSpot } from '../services/spotFetch';
import { fmtMs, type FetchLine } from './fetchFormat';

/**
 * Time budget for ONE extra leg's volatility ladder. Deliberately shorter
 * than the primary leg's DEFAULT_BUDGET_MS (12s, see volPipeline.ts): the
 * legs run concurrently with each other, but a slow leg must not make the
 * whole "Fetch live" action feel stuck for half a minute. A leg that does
 * not answer in time keeps its existing vol/dividend, exactly like the
 * primary leg's own budget expiry does.
 */
export const EXTRA_LEG_BUDGET_MS = 6_000;

/** The label used in the fetch log and as the fallback display name, so a
 * leg with no name yet still reads clearly, e.g. "Leg 2". */
function legLabel(leg: BasketLegState, index: number): string {
  return leg.name || leg.ticker || `Leg ${index + 2}`;
}

/** Settles a promise into a tagged result instead of letting it reject, so
 * `Promise.all` on a leg's several concurrent fetches never short-circuits
 * because one of them failed. */
function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
}

/**
 * Fetches the spot and the volatility ladder for one extra leg, concurrently,
 * and writes the result into `extraLegs[index]` with `setLeg`. Never throws:
 * a failure (network error, or a `fetchVolPipeline` rejection) is caught
 * here and reported as one log line, leaving that leg's existing
 * spot/vol/dividend untouched. This is what keeps one bad leg from taking
 * down the others or the primary when every leg fetches inside the same
 * `Promise.all`.
 *
 * The fetched spot is DISPLAY ONLY (see BasketLegState's doc): it is
 * written to the leg's UI state so the panel can show it, and it never
 * reaches `buildBasket` or a pricing request.
 */
async function fetchOneExtraLeg(
  leg: BasketLegState,
  index: number,
  tenorYears: number,
  rate: number,
  isCurrent: () => boolean,
): Promise<FetchLine[]> {
  const label = legLabel(leg, index);
  if (!leg.ticker.trim()) return []; // Nothing to fetch yet; the user has not picked this leg.

  const t0 = performance.now();
  // Baskets are deliberately spot-free for PRICING (see BasketLegState's
  // doc): every payoff reads relative performance, so a leg never needs its
  // own spot level to build a vol surface. `fetchVolPipeline` still wants A
  // positive spot to build strike levels for the smile, but every strike is
  // expressed as a PERCENT of that spot (see model/skewSurface.ts), so the
  // ATM vol it returns does not depend on which positive number is passed.
  // Reusing the primary leg's spot avoids inventing a second, meaningless
  // number just for this internal calculation.
  const spotForSurface = useMarketStore.getState().market.spot;
  try {
    const [spotResult, vp] = await Promise.all([
      settle(fetchSpot(leg.ticker)),
      fetchVolPipeline({
        symbol: leg.ticker,
        spot: spotForSurface,
        tenorYears,
        rate,
        fallbackVol: leg.vol,
        budgetMs: EXTRA_LEG_BUDGET_MS,
      }),
    ]);
    const ms = performance.now() - t0;
    if (!isCurrent()) return [];

    const divYield = vp.divYield ?? leg.divYield;
    // KEEP THE LEG'S SURFACE, not only its at-the-money point. A worst-of
    // knocks in on the worst leg, so each leg is short a down-and-in put and
    // must price at the volatility of the knock-in strike. Storing `atmVol`
    // alone threw the skew away and priced a 60% barrier at the money.
    const patch: Partial<BasketLegState> = {
      vol: vp.atmVol,
      divYield,
      fetched: true,
      volSurface: vp.surface,
    };
    if (spotResult.ok) {
      patch.spot = spotResult.value.spot;
      // CAPTURE THE LEG'S CURRENCY. Without it nothing downstream can tell a
      // EUR leg from a USD one, and a mixed-currency basket prices as though
      // every leg were in the note currency. `validateBasket` reads this.
      patch.currency = spotResult.value.currency;
    }
    useMarketStore.getState().setLeg(index, patch);

    const lines: FetchLine[] = [
      {
        kind: 'ok',
        msg:
          `${label}: ` +
          (spotResult.ok ? `spot ${spotResult.value.spot}, ` : '') +
          `vol ${(vp.atmVol * 100).toFixed(2)}%, div ${(divYield * 100).toFixed(2)}% · ${vp.label} · ${fmtMs(ms)}`,
        short: `${label} vol ${(vp.atmVol * 100).toFixed(2)}%`,
      },
    ];
    if (!spotResult.ok) {
      const msg = spotResult.error instanceof Error ? spotResult.error.message : 'failed';
      lines.push({ kind: 'info', msg: `${label} spot: ${msg}. Display only, pricing is unaffected.` });
    }
    return lines;
  } catch (e) {
    const ms = performance.now() - t0;
    if (!isCurrent()) return [];
    const msg = e instanceof Error ? e.message : 'failed';
    return [{ kind: 'info', msg: `${label}: ${msg} after ${fmtMs(ms)}. Kept its existing spot, vol and dividend.` }];
  }
}

/**
 * Realized correlation from history for every leg (primary plus extras),
 * written with `setBasketCorrelation`. Only meaningful with two or more
 * legs total, so callers only invoke this once an extra leg exists. A
 * failure leaves the matrix exactly as it was and reports why; it must
 * never block the rest of the fetch.
 *
 * A pair `realizedCorrelationMatrix` could not measure comes back at
 * exactly 0 (see its doc). Zero is not a neutral assumption for two
 * large-cap equities, so any such pair is bumped to
 * `DEFAULT_LEG_CORRELATION` here and the matrix as a whole is labelled
 * `'history'` only when at least one pair was genuinely measured,
 * `'default'` when every pair had to fall back.
 *
 * The matrix that reaches the store is the PRICED correlation, not the
 * realized one. `applyCorrelationRiskPremium` lifts it — read that function
 * for why. The volatility that reaches the engine already carries a
 * volatility risk premium, so a raw realized correlation next to a premium
 * volatility treats the two inputs of a worst-of inconsistently. The panel
 * shows the lifted number, which is the number the note prices at.
 */
export async function populateBasketCorrelation(isCurrent: () => boolean): Promise<FetchLine[]> {
  const store = useMarketStore.getState();
  if (store.extraLegs.length === 0) return [];
  const tickers = [store.ticker, ...store.extraLegs.map((l) => l.ticker)];
  if (tickers.some((t) => !t.trim())) return []; // A leg has no ticker yet; nothing to correlate.

  try {
    const { matrix, errors } = await realizedCorrelationMatrix(tickers);
    if (!isCurrent()) return [];
    let anyMeasured = false;
    const defaulted = matrix.map((row, i) =>
      row.map((v, j) => {
        if (i === j) return 1;
        if (v === 0) return DEFAULT_LEG_CORRELATION;
        anyMeasured = true;
        return v;
      }),
    );
    const source: CorrelationSource = anyMeasured ? 'history' : 'default';
    const priced = applyCorrelationRiskPremium(defaulted);
    useMarketStore.getState().setBasketCorrelation(priced, source);
    const premiumPts = Math.round(CORRELATION_RISK_PREMIUM * 100);
    return [
      {
        kind: errors.length > 0 ? 'info' : 'ok',
        msg:
          errors.length > 0
            ? `Correlation: some pairs unmeasured, defaulted (${errors.join('; ')}). Lifted ${premiumPts} points for the correlation risk premium.`
            : `Correlation matrix populated from 1y realized correlation, lifted ${premiumPts} points for the correlation risk premium.`,
      },
    ];
  } catch (e) {
    if (!isCurrent()) return [];
    const msg = e instanceof Error ? e.message : 'failed';
    return [{ kind: 'info', msg: `Correlation matrix: ${msg}. Left unchanged.` }];
  }
}

/**
 * Runs the volatility ladder for every extra leg concurrently, then
 * populates the correlation matrix from history. Returns one log line per
 * leg plus the correlation outcome, in the same shape `fetchLiveData` uses
 * for the primary leg. Every write is gated on `isCurrent`, exactly like
 * the primary leg's fetch, so a superseded fetch (the user picked a new
 * underlying mid-flight) never lands its result.
 */
export async function fetchExtraLegsLive(
  tenorYears: number,
  rate: number,
  isCurrent: () => boolean,
): Promise<FetchLine[]> {
  const legs = useMarketStore.getState().extraLegs;
  if (legs.length === 0) return [];

  const perLeg = await Promise.all(
    legs.map((leg, i) => fetchOneExtraLeg(leg, i, tenorYears, rate, isCurrent)),
  );
  const lines = perLeg.flat();

  if (isCurrent()) {
    lines.push(...(await populateBasketCorrelation(isCurrent)));
  }
  return lines;
}
