import { useEffect, useRef, useState } from 'react';
import { useMarketStore } from '../state/marketStore';
import { fetchSpot, recentRouteAttempts, type RouteAttempt } from '../services/spotFetch';
import { fetchFxRealizedVolAndCorr, fetchRateCurve, fetchRefRate, REF_RATE_CCYS } from '../services/marketFetch';
import { fetchVolPipeline, type VolSourceKind } from '../services/volPipeline';
import { useTradeStore } from '../state/tradeStore';
import { NumericField } from './NumericField';
import { SelectField } from './SelectField';
import { Segmented } from './Segmented';
import { TickerSearch } from './TickerSearch';
import { BasketPanel } from './BasketPanel';
import { buildBasket } from '../model/basket';
import { NO_COSTS, SUPPORTED_CURRENCIES as CURRENCIES, type CostParams } from '../model/market';
import { skewPoints } from '../model/volSurface';
import { fmtMs, type FetchLine } from './fetchFormat';
import { fetchExtraLegsLive } from './basketFetch';
import type { SymbolMatch } from '../services/symbolSearch';

/** Await a promise without changing its outcome, but also capture how long it
 * took. Never rejects: a failing leg reports `ok: false` instead, so callers
 * can build the fetch log's timing without a second try/catch around every
 * leg. */
function timed<T>(p: Promise<T>): Promise<{ ms: number } & ({ ok: true; value: T } | { ok: false; error: unknown })> {
  const t0 = performance.now();
  return p.then(
    (value) => ({ ms: performance.now() - t0, ok: true as const, value }),
    (error) => ({ ms: performance.now() - t0, ok: false as const, error }),
  );
}

/** One line naming how many route attempts landed on each winner, e.g.
 * "allorigins.win 3, direct 1" or "direct 2, failed 1" when a route
 * exhausted every hedge. Grouped in first-seen order, not alphabetically, so
 * the dominant route usually reads first. */
function summarizeRoutes(attempts: RouteAttempt[]): string {
  const counts = new Map<string, number>();
  for (const a of attempts) {
    const label = a.winner ?? 'failed';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, n]) => `${label} ${n}`).join(', ');
}

/** Reported alongside the fetch lines, so the vol field can show which rung
 * of the ladder produced the current number without re-deriving it.
 *
 * `label` is the SHORT form for the panel ("VIX-scaled realized"); `full`
 * carries the whole descriptive string ("VIX-scaled realized (Yang-Zhang +
 * EWMA (flat))"), and `note` any additional caveat. Both `full` and `note`
 * are hover-only — see the "Source:" line below — so the panel never shows
 * the long provenance blob the model string carries. */
export interface VolSourceInfo {
  kind: VolSourceKind;
  label: string;
  full: string;
  note?: string;
}

/** Splits a descriptive label at its first parenthetical, e.g.
 * "VIX-scaled realized (Yang-Zhang + EWMA (flat))" -> "VIX-scaled
 * realized". The parenthetical often nests further parens of its own (as
 * above), so a regex anchored on the closing paren cannot find the right
 * one; cutting at the first opening paren does not have that problem. */
function shortLabel(label: string): string {
  const i = label.indexOf(' (');
  return i === -1 ? label : label.slice(0, i);
}

/**
 * One-shot live data fetch. Concurrently:
 *  - spot, Yahoo then Stooq — also detects the underlying's trading currency
 *  - reference rate (€STR/SOFR), when the note ccy has an open source
 * Then the volatility source ladder runs (see services/volPipeline.ts), all
 * rungs keyless: the marketdata.app chain, the existing keyless chain path
 * (Yahoo v7, then CBOE), a listed vol-index anchor, a market-wide
 * VIX-scaled ratio, and finally plain realized vol as the last resort.
 * Applies whatever the ladder produced, and reports each component's
 * outcome loudly.
 */
async function fetchLiveData(
  ticker: string,
  noteCcy: string,
  tenorYears: number,
  rate: number,
  /** False once a newer fetch has superseded this one; every store write is
   * gated on it so a slow leg of an abandoned fetch cannot overwrite the
   * current underlying's data. */
  isCurrent: () => boolean = () => true,
): Promise<{ lines: FetchLine[]; volSource?: VolSourceInfo; divNote?: string }> {
  const lines: FetchLine[] = [];
  const store = useMarketStore.getState();

  // Timing for the whole call, and a snapshot of the diagnostics buffer taken
  // before any leg starts, so the final summary line can identify exactly
  // which route attempts belong to THIS fetch and not an earlier or
  // concurrent one. Comparing by reference, not by count, stays correct even
  // if the ring buffer wraps mid-call.
  const callStart = performance.now();
  const attemptsBefore = recentRouteAttempts();
  const finalizeSummary = () => {
    const totalMs = performance.now() - callStart;
    const newAttempts = recentRouteAttempts().filter((a) => !attemptsBefore.includes(a));
    const routeSummary = newAttempts.length > 0 ? summarizeRoutes(newAttempts) : 'no network route used';
    const n = newAttempts.length;
    lines.push({
      kind: 'info',
      msg: `${n} request${n === 1 ? '' : 's'} · ${routeSummary} · total ${fmtMs(totalMs)}`,
    });
  };

  /** The reference rate for one currency, or a rejection naming the gap. */
  const rateFor = (ccy: string) =>
    (REF_RATE_CCYS as readonly string[]).includes(ccy)
      ? fetchRefRate(ccy)
      : Promise.reject(new Error(`no open rate source for ${ccy}. Enter manually.`));

  const spotP = fetchSpot(ticker);
  // Start the rate OPTIMISTICALLY for the currency the note holds right now.
  // In the common case the underlying keeps that currency and this costs no
  // extra latency. When it does not, the optimistic answer is discarded below.
  const optimisticP = rateFor(noteCcy);

  const [spotT, optimisticT] = await Promise.all([timed(spotP), timed(optimisticP)]);

  let underlyingCcy: string | undefined;
  // The vol pipeline needs a spot even when the live spot fetch failed —
  // fall back to whatever is already in the store (a manual entry, or a
  // previous fetch), same as the realized-surface builder always did.
  let spotForVol = store.market.spot;
  if (spotT.ok) {
    underlyingCcy = spotT.value.currency;
    spotForVol = spotT.value.spot;
    if (!isCurrent()) { finalizeSummary(); return { lines }; }
    store.applyFetchedSpot(spotT.value.spot, spotT.value.source, spotT.value.asOf, spotT.value.currency);
    lines.push({
      kind: 'ok',
      msg: `Spot ${spotT.value.spot} · ${spotT.value.source} · ${fmtMs(spotT.ms)}`,
      short: `spot ${spotT.value.spot}`,
    });
  } else {
    const msg = spotT.error instanceof Error ? spotT.error.message : 'failed';
    lines.push({ kind: 'err', msg: `Spot: ${msg} after ${fmtMs(spotT.ms)}` });
  }

  // The rate MUST match the currency the note ends up in. The spot fetch is
  // what discovers the underlying's currency, so a rate requested before it
  // returned can be for the wrong one: picking a USD name into a EUR note used
  // to write the EUR rate and label it "ECB EURSTR" on a USD note, silently
  // mis-discounting every cashflow. So re-request whenever the currency moved.
  const finalCcy = useMarketStore.getState().market.currency;
  const rateT = finalCcy === noteCcy ? optimisticT : await timed(rateFor(finalCcy));

  if (rateT.ok) {
    if (isCurrent()) {
      useMarketStore.setState((s) => ({ market: { ...s.market, rate: rateT.value.rate } }));
      lines.push({
        kind: 'ok',
        msg: `Rate ${(rateT.value.rate * 100).toFixed(3)}% · ${rateT.value.source} ${rateT.value.asOf} · ${fmtMs(rateT.ms)}`,
        short: `rate ${(rateT.value.rate * 100).toFixed(3)}%`,
      });
    }
  } else {
    const msg = rateT.error instanceof Error ? rateT.error.message : 'failed';
    lines.push({ kind: 'err', msg: `Rate: ${msg} after ${fmtMs(rateT.ms)}` });
  }

  // The rate CURVE, best-effort: 3M/1Y/2Y/5Y zero rates for the note
  // currency, so discounting and the path drift follow the term structure
  // instead of one overnight fixing held flat to the final tenor. Only EUR
  // and USD have a keyless source; the other currencies keep the flat rate
  // and the model reports flat discounting, honestly. A failed curve fetch
  // is reported but never fatal: flat pricing remains correct, just less
  // exact at long tenors.
  if (isCurrent()) {
    try {
      const rc = await fetchRateCurve(finalCcy);
      if (isCurrent()) {
        useMarketStore.setState((s) => ({ market: { ...s.market, rateCurve: rc.curve } }));
        lines.push({
          kind: 'ok',
          msg: `Rate curve ${rc.curve.map((p) => `${p.tYears}y ${(p.rate * 100).toFixed(2)}%`).join(' / ')} · ${rc.source}`,
          short: `curve ${rc.curve.map((p) => `${(p.rate * 100).toFixed(2)}%`).join('/')}`,
        });
      }
    } catch (rcErr) {
      if (isCurrent()) {
        lines.push({
          kind: 'info',
          msg: `Rate curve: ${rcErr instanceof Error ? rcErr.message : 'failed'}. Discounting stays flat.`,
        });
      }
    }
  }

  if (!isCurrent()) { finalizeSummary(); return { lines }; }

  let volSource: VolSourceInfo | undefined;
  let divNote: string | undefined;
  const volStart = performance.now();
  try {
    const vp = await fetchVolPipeline({
      symbol: ticker,
      spot: spotForVol,
      tenorYears,
      rate,
      fallbackVol: useMarketStore.getState().market.vol,
    });
    const volMs = performance.now() - volStart;
    if (!isCurrent()) { finalizeSummary(); return { lines }; }

    let skewMsg = '';
    try {
      const skew = skewPoints(vp.surface, tenorYears, 80);
      skewMsg = ` · skew ${skew >= 0 ? '+' : ''}${(skew * 100).toFixed(1)}pt (80% vs ATM)`;
    } catch {
      skewMsg = '';
    }

    useMarketStore.setState((s) => ({
      market: {
        ...s.market,
        vol: vp.atmVol,
        divYield: vp.divYield ?? s.market.divYield,
        volSurface: vp.surface,
      },
    }));
    // The realized-derived caveat matters: it tells the user this number is
    // not a quoted implied vol. Keep it, but as a HOVER tooltip on the
    // source line below rather than a permanent sentence in the panel — see
    // `volSource`'s render below.
    const realizedCaveat =
      vp.kind === 'realized' || vp.kind === 'realized-scaled' || vp.kind === 'vol-index'
        ? 'No option chain. Vol and skew are realized-derived, not directly quoted implied vol.'
        : undefined;
    volSource = {
      kind: vp.kind,
      label: shortLabel(vp.label),
      full: vp.label,
      note: [vp.note, realizedCaveat].filter(Boolean).join(' ') || undefined,
    };
    divNote = vp.divNote;
    lines.push({
      kind: 'ok',
      msg:
        `Vol ${(vp.atmVol * 100).toFixed(2)}% · ${vp.label}` +
        (vp.divYield !== undefined ? `, div ${(vp.divYield * 100).toFixed(2)}%` : '') +
        skewMsg +
        ` · ${fmtMs(volMs)}`,
      short: `vol ${(vp.atmVol * 100).toFixed(2)}%`,
    });
  } catch (e) {
    const volMs = performance.now() - volStart;
    const msg = e instanceof Error ? e.message : 'all sources failed';
    lines.push({ kind: 'err', msg: `Vol: ${msg} after ${fmtMs(volMs)}` });
  }

  // Extra basket legs (worst-of legs 2 and up) get the SAME volatility
  // ladder as the primary leg, concurrently with each other so three legs
  // cost about one ladder run, not three run in series. Started here, right
  // after the primary leg's own vol/div land, and awaited near the end of
  // this function so it runs alongside the primary leg's remaining work
  // (rate curve, quanto) instead of serialising after it.
  const extraLegsP = fetchExtraLegsLive(tenorYears, rate, isCurrent);

  // Cross-currency note: the quanto drift needs the UNDERLYING currency's
  // rate, not the note rate. Fetch it when there is a mismatch and an open
  // source exists. FX vol and Eq-FX correlation are auto-filled from Yahoo
  // 1Y realized FX/equity closes, best-effort; manual edits still override.
  //
  // Compare against `finalCcy`, the currency the note ended up in, not the
  // entry-time `noteCcy`. The spot fetch can switch the note currency to
  // match the underlying (applyFetchedSpot's currency-follows logic), so a
  // same-currency note is easy to mistake for a cross-currency one if the
  // comparison uses the stale value. That mistake fired the quanto branch —
  // and its FX vol/correlation fetch and drift write — on a Swiss stock in
  // a Swiss note, exactly like the stale rate did before the finalCcy fix
  // below.
  if (underlyingCcy && underlyingCcy !== finalCcy && isCurrent()) {
    const cur = useMarketStore.getState().market.quanto;
    if ((REF_RATE_CCYS as readonly string[]).includes(underlyingCcy)) {
      const urStart = performance.now();
      try {
        const ur = await fetchRefRate(underlyingCcy);
        const urMs = performance.now() - urStart;
        if (!isCurrent()) { finalizeSummary(); return { lines, volSource, divNote }; }
        const latest = useMarketStore.getState().market.quanto;
        useMarketStore.getState().setQuanto({
          rateUnderlying: ur.rate,
          fxVol: latest?.fxVol ?? cur?.fxVol ?? 0.1,
          corrEqFx: latest?.corrEqFx ?? cur?.corrEqFx ?? 0,
        });
        lines.push({
          kind: 'ok',
          msg: `Underlying rate ${(ur.rate * 100).toFixed(3)}% · ${ur.source} · ${fmtMs(urMs)}`,
          short: `ul rate ${(ur.rate * 100).toFixed(3)}%`,
        });
      } catch (urErr) {
        const urMs = performance.now() - urStart;
        const msg = urErr instanceof Error ? urErr.message : 'failed';
        lines.push({ kind: 'info', msg: `Underlying rate: ${msg} after ${fmtMs(urMs)}. Enter manually.` });
      }
    } else {
      lines.push({ kind: 'info', msg: `No open rate source for ${underlyingCcy}. Set the underlying rate manually.` });
    }

    const fxStart = performance.now();
    try {
      const fx = await fetchFxRealizedVolAndCorr(underlyingCcy, finalCcy, ticker);
      const fxMs = performance.now() - fxStart;
      if (!isCurrent()) { finalizeSummary(); return { lines, volSource, divNote }; }
      const latest = useMarketStore.getState().market.quanto;
      useMarketStore.getState().setQuanto({
        rateUnderlying: latest?.rateUnderlying ?? cur?.rateUnderlying ?? 0,
        fxVol: fx.fxVol,
        corrEqFx: fx.corrEqFx,
      });
      lines.push({
        kind: 'ok',
        msg: `FX vol ${(fx.fxVol * 100).toFixed(1)}%, eq-FX corr ${fx.corrEqFx.toFixed(2)} · ${fx.source} · ${fmtMs(fxMs)}`,
        short: `fx ${(fx.fxVol * 100).toFixed(1)}%/${fx.corrEqFx.toFixed(2)}`,
      });
    } catch (fxErr) {
      const fxMs = performance.now() - fxStart;
      const msg = fxErr instanceof Error ? fxErr.message : 'failed';
      lines.push({
        kind: 'info',
        msg: `FX vol/correlation: ${msg} after ${fmtMs(fxMs)}. Enter manually.`,
      });
    }
  }

  // Merged last, so the leg lines land after the primary leg's own lines
  // regardless of how long the ladder took on each side.
  lines.push(...(await extraLegsP));

  finalizeSummary();
  return { lines, volSource, divNote };
}

export function MarketPanel() {
  const market = useMarketStore((s) => s.market);
  const underlyingName = useMarketStore((s) => s.underlyingName);
  const manualOverride = useMarketStore((s) => s.manualOverride);
  const ticker = useMarketStore((s) => s.ticker);
  const underlyingCurrency = useMarketStore((s) => s.underlyingCurrency);
  const setMarket = useMarketStore((s) => s.setMarket);
  const setQuanto = useMarketStore((s) => s.setQuanto);
  const setBasket = useMarketStore((s) => s.setBasket);
  const setUnderlying = useMarketStore((s) => s.setUnderlying);

  const assetType = useMarketStore((s) => s.assetType);
  const setAssetType = useMarketStore((s) => s.setAssetType);
  const extraLegs = useMarketStore((s) => s.extraLegs);
  const basketCorrelation = useMarketStore((s) => s.basketCorrelation);
  const activePage = useTradeStore((s) => s.activePage);

  const [fetching, setFetching] = useState(false);
  const [fetchLines, setFetchLines] = useState<FetchLine[]>([]);
  const [volSource, setVolSource] = useState<VolSourceInfo | undefined>(undefined);
  const [divNote, setDivNote] = useState<string | undefined>(undefined);
  // Collapsed by default: funding spread, borrow and fee are all zero on
  // most trades, and a pure risk-neutral price does not need this section
  // open to be understood. The one-line summary below still shows whether
  // costs are active without expanding it.
  const [costsOpen, setCostsOpen] = useState(false);
  // A previous version of this panel stored a user-entered Alpha Vantage
  // API key here. The vol pipeline no longer has any rung that needs a
  // key, so clear a lingering value out of the user's browser storage —
  // it does nothing now and should not sit there indefinitely.
  useEffect(() => {
    try {
      localStorage.removeItem('eqsp.alphaVantageKey');
    } catch {
      // Private browsing or a blocked storage API — nothing to clean up.
    }
  }, []);
  // Monotonic token identifying the newest fetch. Picking a different
  // underlying used to leave the previous fetch running: its slow legs (the
  // option chain waits up to 10s) then landed afterwards and wrote the OLD
  // underlying's vol, div yield and status lines over the new one. Only the
  // newest token is allowed to apply its results.
  const fetchGeneration = useRef(0);

  async function handleFetchLive(sym = ticker) {
    const generation = ++fetchGeneration.current;
    setFetching(true);
    setFetchLines([]);
    setVolSource(undefined);
    setDivNote(undefined);
    const trade = useTradeStore.getState();
    const page = trade.activePage;
    const spec =
      page === 'coupon'
        ? trade.couponSpec
        : page === 'participation'
          ? trade.participationSpec
          : trade.accumulatorSpec;
    const { lines, volSource: vs, divNote: dn } = await fetchLiveData(
      sym,
      // Read the currency from the STORE, not the render closure. The picker
      // sets the note currency synchronously in setUnderlying before calling
      // this handler, but the closure's `market` still holds the pre-pick
      // value. Passing that stale value made the fetch treat a freshly
      // same-currency note as cross-currency: a Swiss stock picked into a
      // CHF note ran the quanto branch against the old EUR note, fetched FX
      // vol/correlation, and reported an FX line that never should have
      // existed.
      useMarketStore.getState().market.currency,
      spec.tenorYears,
      market.rate,
      () => fetchGeneration.current === generation,
    );
    if (fetchGeneration.current !== generation) return; // superseded
    setFetchLines(lines);
    setVolSource(vs);
    setDivNote(dn);
    setFetching(false);
  }

  /** Newest manual currency change, so a quick double-switch cannot let the
   * slower rate land after the faster one. */
  const rateGeneration = useRef(0);

  /**
   * Changing the note currency changes which reference rate applies, so fetch
   * it. A EUR rate left sitting on a JPY note is not a stale convenience, it is
   * a wrong discount rate, and it silently mis-prices every cashflow. Failure
   * is reported, never silent, and never overwrites with a guess.
   */
  async function handleCurrencyChange(next: string) {
    if (next === market.currency) return;
    setMarket({ currency: next });
    const generation = ++rateGeneration.current;
    if (!(REF_RATE_CCYS as readonly string[]).includes(next)) {
      setFetchLines([{ kind: 'info', msg: `No open rate source for ${next}. Enter the rate manually.` }]);
      return;
    }
    try {
      const r = await fetchRefRate(next);
      if (rateGeneration.current !== generation) return;
      setMarket({ rate: r.rate });
      const lines: FetchLine[] = [
        {
          kind: 'ok',
          msg: `Rate ${(r.rate * 100).toFixed(3)}% · ${r.source} ${r.asOf}`,
          short: `rate ${(r.rate * 100).toFixed(3)}%`,
        },
      ];
      // The note currency changed, so the discount curve must change with
      // it. Best-effort like the fetch path; a failure keeps the flat rate.
      try {
        const rc = await fetchRateCurve(next);
        if (rateGeneration.current !== generation) return;
        setMarket({ rate: r.rate, rateCurve: rc.curve });
        lines.push({
          kind: 'ok',
          msg: `Rate curve ${rc.curve.map((p) => `${p.tYears}y ${(p.rate * 100).toFixed(2)}%`).join(' / ')} · ${rc.source}`,
          short: `curve ${rc.curve.map((p) => `${(p.rate * 100).toFixed(2)}%`).join('/')}`,
        });
      } catch (rcErr) {
        if (rateGeneration.current !== generation) return;
        setMarket({ rate: r.rate, rateCurve: undefined });
        lines.push({
          kind: 'info',
          msg: `Rate curve for ${next}: ${rcErr instanceof Error ? rcErr.message : 'failed'}. Discounting stays flat.`,
        });
      }
      setFetchLines(lines);
    } catch (e) {
      if (rateGeneration.current !== generation) return;
      setFetchLines([
        { kind: 'err', msg: `Rate for ${next}: ${e instanceof Error ? e.message : 'failed'}` },
      ]);
    }
  }

  // A worst-of has no primary underlying: every leg is economically equal,
  // and the price depends on the worst of them. With a single leg the panel
  // must look exactly as a plain single-name trade always has, so this only
  // switches the primary leg's ticker/vol/dividend into the uniform basket
  // list once a second leg exists.
  const nLegs = 1 + extraLegs.length;

  /** Picking a new primary-leg ticker, whether from the standalone search
   * (single-leg layout) or from column 1 of the basket grid (two or more
   * legs). Both paths must behave identically: set the leg, then fetch
   * live data for it. */
  function handlePrimaryPick(m: SymbolMatch) {
    setUnderlying(m.symbol, m.name, m.quoteType === 'INDEX' ? 'index' : 'share', m.currency);
    void handleFetchLive(m.symbol);
  }

  const quantoMismatch = !!underlyingCurrency && underlyingCurrency !== market.currency;

  // Costs default to zero, a pure risk-neutral fair value. The badge makes
  // it obvious when a quoted level is no longer the fair value.
  const costs = market.costs ?? NO_COSTS;
  const costsActive = costs.fundingSpreadBp !== 0 || costs.borrowCostBp !== 0 || costs.feePct !== 0;
  const setCosts = (patch: Partial<CostParams>) => setMarket({ costs: { ...costs, ...patch } });

  // When a currency mismatch first appears, seed quanto params from the
  // current note rate. When it resolves, or the underlying ccy is unknown,
  // clear them, so single-currency pricing is untouched.
  useEffect(() => {
    if (quantoMismatch && !market.quanto) {
      setQuanto({ rateUnderlying: market.rate, fxVol: 0.1, corrEqFx: 0 });
    } else if (!quantoMismatch && market.quanto) {
      setQuanto(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quantoMismatch, market.quanto]);

  // Rebuilds MarketData.basket whenever a leg or the correlation matrix
  // changes. The accumulator page forces it undefined regardless of how
  // many legs are configured: AccumulatorSpec keeps exactly one underlying
  // (see model/product.ts), so a basket must never reach an accumulator
  // request even if the user added legs while on another tab.
  useEffect(() => {
    // Leg 0 is the primary underlying, so its surface is the one the market
    // panel already tracks. Each extra leg carries its own, measured by its
    // own fetch. Both reach `effectiveMarketFor`, which reads them at the
    // product's risk strike.
    const primary = {
      name: underlyingName,
      vol: market.vol,
      divYield: market.divYield,
      volSurface: market.volSurface,
    };
    const legs = activePage === 'accumulator' ? [primary] : [primary, ...extraLegs];
    const { basket } = buildBasket(legs, basketCorrelation);
    if (JSON.stringify(basket ?? null) !== JSON.stringify(market.basket ?? null)) {
      setBasket(basket);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activePage,
    underlyingName,
    market.vol,
    market.divYield,
    market.volSurface,
    extraLegs,
    basketCorrelation,
    market.basket,
  ]);

  // Accumulator keeps exactly one underlying, permanently (see
  // model/product.ts's AccumulatorSpec comment), so the basket UI never
  // shows there even if the user added legs while on another tab.
  const basketUiEnabled = activePage !== 'accumulator';
  const singleLegLayout = !basketUiEnabled || nLegs === 1;

  return (
    <div>
      <h3 className="sidebar-title">Market Data</h3>
      <div className="field-group">
        <SelectField
          label="Currency"
          value={market.currency}
          options={CURRENCIES.map((c) => ({ value: c, label: c }))}
          onChange={(v) => void handleCurrencyChange(v)}
        />

        {/* With one leg, this IS the underlying picker, exactly as a plain
         * single-name trade has always looked. With two or more legs, the
         * ticker search for every leg — including this one — moves into the
         * basket grid below, one column per leg, so leg 1 does not look any
         * more important than leg 3. */}
        {singleLegLayout && (
          <TickerSearch ticker={ticker} displayName={underlyingName} onPick={handlePrimaryPick} />
        )}

        <div className="field">
          <div className="field-label">
            <span>Asset type</span>
          </div>
          <Segmented
            value={assetType}
            options={[
              { value: 'share', label: 'Share' },
              { value: 'index', label: 'Index' },
            ]}
            onChange={setAssetType}
          />
        </div>

        <button
          className="btn btn-sm btn-primary"
          type="button"
          disabled={fetching}
          onClick={() => void handleFetchLive()}
          title="Fetches delayed spot, reference rate, and options-implied vol + dividend yield (falling back to 1Y realized vol) for every leg in one go. Manual edits always override."
        >
          {fetching ? 'Fetching…' : 'Fetch live data'}
        </button>
        {(() => {
          const okLines = fetchLines.filter((l) => l.kind === 'ok');
          const otherLines = fetchLines.filter((l) => l.kind !== 'ok');
          return (
            <>
              {okLines.length > 0 && (
                <div className="status-line ok" title={okLines.map((l) => l.msg).join(' · ')}>
                  ✓ {okLines.map((l) => l.short ?? l.msg).join(' · ')}
                </div>
              )}
              {otherLines.map((l, i) => (
                <div key={i} className={`status-line ${l.kind === 'err' ? 'error' : ''}`}>
                  {l.msg}
                </div>
              ))}
            </>
          );
        })()}
        {quantoMismatch && (
          <div className="status-line warn">
            {market.quanto
              ? 'Cross-currency note. Quanto drift adjustment is active.'
              : `Underlying trades in ${underlyingCurrency}, note in ${market.currency}. Quanto and composite effects are not modelled, so prices assume a single currency.`}
          </div>
        )}

        {singleLegLayout && (
          <>
            <NumericField
              label="Spot"
              value={market.spot}
              step={0.01}
              onChange={(v) => setMarket({ spot: v })}
              badge={manualOverride ? 'MANUAL' : undefined}
              badgeClassName="manual-badge"
            />

            <NumericField
              label="Volatility"
              value={Number((market.vol * 100).toFixed(4))}
              step={0.5}
              suffix="%"
              onChange={(v) => setMarket({ vol: v / 100 })}
            />
            {volSource && (
              <div className="status-line" title={[volSource.full, volSource.note].filter(Boolean).join('. ')}>
                Source: {volSource.label}
              </div>
            )}

            {/* A worst-of basket cannot be multi-currency in this engine
             * (the quanto drift needs one equity-FX correlation PER LEG,
             * and QuantoParams carries only one — see validateBasket), so
             * the only case with a second genuine rate is a QUANTO
             * SINGLE-NAME note: the note currency's rate and the
             * underlying currency's rate, shown side by side. This branch
             * cannot fire once a second leg exists, so it is safe here in
             * the single-leg layout only. */}
            {market.quanto ? (
              <div className="metric-grid cols-2">
                <NumericField
                  label={`Rate ${market.currency}`}
                  value={Number((market.rate * 100).toFixed(4))}
                  step={0.1}
                  suffix="%"
                  onChange={(v) => setMarket({ rate: v / 100 })}
                />
                <NumericField
                  label={`Rate ${underlyingCurrency ?? 'underlying'}`}
                  value={Number((market.quanto.rateUnderlying * 100).toFixed(4))}
                  step={0.1}
                  suffix="%"
                  onChange={(v) => setQuanto({ ...market.quanto!, rateUnderlying: v / 100 })}
                />
              </div>
            ) : (
              <NumericField
                label="Rate"
                value={Number((market.rate * 100).toFixed(4))}
                step={0.1}
                suffix="%"
                onChange={(v) => setMarket({ rate: v / 100 })}
              />
            )}

            <NumericField
              label="Dividend yield"
              value={Number((market.divYield * 100).toFixed(4))}
              step={0.1}
              suffix="%"
              title={divNote}
              onChange={(v) => setMarket({ divYield: v / 100 })}
            />
          </>
        )}

        {/* Two or more legs: this basket can never be quanto (see the note
         * above), so the rate is always the plain single field, moved here
         * because it is a note-level input, not a per-leg one. */}
        {!singleLegLayout && (
          <NumericField
            label="Rate"
            value={Number((market.rate * 100).toFixed(4))}
            step={0.1}
            suffix="%"
            onChange={(v) => setMarket({ rate: v / 100 })}
          />
        )}

        {basketUiEnabled && <BasketPanel onPickPrimary={handlePrimaryPick} />}

        {/* Quanto FX inputs. Rendered only when the note actually IS quanto
         * (market.quanto set): no empty heading and no reserved space on
         * the common single-currency trade. */}
        {market.quanto && (
          <div className="field-group">
            <div className="field-label">
              <span>Quanto FX</span>
            </div>
            <div className="field-row">
              <NumericField
                label="FX vol"
                value={Number((market.quanto.fxVol * 100).toFixed(4))}
                step={0.5}
                suffix="%"
                onChange={(v) => setQuanto({ ...market.quanto!, fxVol: v / 100 })}
              />
              <NumericField
                label="Eq-FX correlation"
                value={Number(market.quanto.corrEqFx.toFixed(2))}
                step={0.05}
                min={-1}
                max={1}
                onChange={(v) => setQuanto({ ...market.quanto!, corrEqFx: Math.min(1, Math.max(-1, v)) })}
              />
            </div>
          </div>
        )}

        {/* Issuer and desk costs. A pure risk-neutral price ignores these. That is
         * why a fair value looks more aggressive than a bank's quote. Their
         * signs deliberately differ — see CostParams in model/market.ts.
         * Collapsed by default, like the correlation editor: the one-line
         * summary below always shows whether costs are active, so a
         * collapsed non-zero cost is never a silent trap. */}
        <div className="field-group">
          <div className="field-label">
            <span>Costs</span>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {costsActive && <span className="solved-badge">ON</span>}
              <button type="button" className="btn btn-sm" onClick={() => setCostsOpen((o) => !o)}>
                {costsOpen ? 'Hide' : 'Edit'}
              </button>
            </span>
          </div>
          {!costsOpen && (
            <div className="status-line">
              {costsActive
                ? `Funding +${costs.fundingSpreadBp}bp · Borrow ${costs.borrowCostBp}bp · Fee ${costs.feePct}%`
                : 'No costs. Pricing is the pure risk-neutral fair value.'}
            </div>
          )}
          {costsOpen && (
            <>
              <div className="field-row">
                <NumericField
                  label="Funding spread"
                  value={costs.fundingSpreadBp}
                  step={5}
                  suffix="bp"
                  title="Issuer funding spread over the risk-free rate. A note is a funded liability, so a wider spread cheapens the bond component and lets the issuer pay MORE."
                  onChange={(v) => setCosts({ fundingSpreadBp: v })}
                />
                <NumericField
                  label="Borrow cost"
                  value={costs.borrowCostBp}
                  step={5}
                  suffix="bp"
                  title="Stock borrow / repo carried by the hedge. Lowers the forward, making the short puts dearer, so it REDUCES the coupon."
                  onChange={(v) => setCosts({ borrowCostBp: v })}
                />
              </div>
              <NumericField
                label="Fee / margin"
                value={costs.feePct}
                step={0.1}
                suffix="%"
                title="Distribution fee retained upfront. The main reason a bank's quote is less aggressive than fair value."
                onChange={(v) => setCosts({ feePct: v })}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
