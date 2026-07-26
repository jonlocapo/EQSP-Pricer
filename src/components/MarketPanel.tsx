import { useEffect, useRef, useState } from 'react';
import { useMarketStore } from '../state/marketStore';
import { fetchSpot } from '../services/spotFetch';
import { fetchFxRealizedVolAndCorr, fetchRefRate, REF_RATE_CCYS } from '../services/marketFetch';
import { fetchVolPipeline, type VolSourceKind } from '../services/volPipeline';
import { useTradeStore } from '../state/tradeStore';
import { NumericField } from './NumericField';
import { SelectField } from './SelectField';
import { Segmented } from './Segmented';
import { TickerSearch } from './TickerSearch';
import { NO_COSTS, SUPPORTED_CURRENCIES as CURRENCIES, type CostParams } from '../model/market';
import { skewPoints } from '../model/volSurface';

interface FetchLine {
  kind: 'ok' | 'err' | 'info';
  msg: string;
  /** Compact form used when rolling successful fetches into one summary line. */
  short?: string;
}

/** Reported alongside the fetch lines, so the vol field can show which rung
 * of the ladder produced the current number without re-deriving it. */
export interface VolSourceInfo {
  kind: VolSourceKind;
  label: string;
  note?: string;
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
): Promise<{ lines: FetchLine[]; volSource?: VolSourceInfo }> {
  const lines: FetchLine[] = [];
  const store = useMarketStore.getState();

  const spotP = fetchSpot(ticker);
  const rateP = (REF_RATE_CCYS as readonly string[]).includes(noteCcy)
    ? fetchRefRate(noteCcy)
    : Promise.reject(new Error(`no open rate source for ${noteCcy}. Enter manually.`));

  const [spotR, rateR] = await Promise.allSettled([spotP, rateP]);

  let underlyingCcy: string | undefined;
  // The vol pipeline needs a spot even when the live spot fetch failed —
  // fall back to whatever is already in the store (a manual entry, or a
  // previous fetch), same as the realized-surface builder always did.
  let spotForVol = store.market.spot;
  if (spotR.status === 'fulfilled') {
    underlyingCcy = spotR.value.currency;
    spotForVol = spotR.value.spot;
    if (!isCurrent()) return { lines };
    store.applyFetchedSpot(spotR.value.spot, spotR.value.source, spotR.value.asOf, spotR.value.currency);
    lines.push({ kind: 'ok', msg: `Spot ${spotR.value.spot} · ${spotR.value.source}`, short: `spot ${spotR.value.spot}` });
  } else {
    lines.push({ kind: 'err', msg: `Spot: ${spotR.reason instanceof Error ? spotR.reason.message : 'failed'}` });
  }

  if (rateR.status === 'fulfilled') {
    if (isCurrent()) {
      useMarketStore.setState((s) => ({ market: { ...s.market, rate: rateR.value.rate } }));
      lines.push({
        kind: 'ok',
        msg: `Rate ${(rateR.value.rate * 100).toFixed(3)}% · ${rateR.value.source} ${rateR.value.asOf}`,
        short: `rate ${(rateR.value.rate * 100).toFixed(3)}%`,
      });
    }
  } else {
    lines.push({ kind: 'err', msg: `Rate: ${rateR.reason instanceof Error ? rateR.reason.message : 'failed'}` });
  }

  if (!isCurrent()) return { lines };

  let volSource: VolSourceInfo | undefined;
  try {
    const vp = await fetchVolPipeline({
      symbol: ticker,
      spot: spotForVol,
      tenorYears,
      rate,
      fallbackVol: useMarketStore.getState().market.vol,
    });
    if (!isCurrent()) return { lines };

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
    volSource = { kind: vp.kind, label: vp.label, note: vp.note };
    lines.push({
      kind: 'ok',
      msg:
        `Vol ${(vp.atmVol * 100).toFixed(2)}% · ${vp.label}` +
        (vp.divYield !== undefined ? `, div ${(vp.divYield * 100).toFixed(2)}%` : '') +
        skewMsg +
        (vp.note ? ` · ${vp.note}` : ''),
      short: `vol ${(vp.atmVol * 100).toFixed(2)}%`,
    });
    if (vp.kind === 'realized' || vp.kind === 'realized-scaled' || vp.kind === 'vol-index') {
      lines.push({
        kind: 'info',
        msg: 'No option chain. Vol and skew are realized-derived, not directly quoted implied vol.',
      });
    }
  } catch (e) {
    lines.push({ kind: 'err', msg: `Vol: ${e instanceof Error ? e.message : 'all sources failed'}` });
    lines.push({ kind: 'info', msg: 'Div yield left as entered' });
  }

  // Cross-currency note: the quanto drift needs the UNDERLYING currency's
  // rate, not the note rate. Fetch it when there is a mismatch and an open
  // source exists. FX vol and Eq-FX correlation are auto-filled from Yahoo
  // 1Y realized FX/equity closes, best-effort; manual edits still override.
  if (underlyingCcy && underlyingCcy !== noteCcy && isCurrent()) {
    const cur = useMarketStore.getState().market.quanto;
    if ((REF_RATE_CCYS as readonly string[]).includes(underlyingCcy)) {
      try {
        const ur = await fetchRefRate(underlyingCcy);
        if (!isCurrent()) return { lines, volSource };
        const latest = useMarketStore.getState().market.quanto;
        useMarketStore.getState().setQuanto({
          rateUnderlying: ur.rate,
          fxVol: latest?.fxVol ?? cur?.fxVol ?? 0.1,
          corrEqFx: latest?.corrEqFx ?? cur?.corrEqFx ?? 0,
        });
        lines.push({
          kind: 'ok',
          msg: `Underlying rate ${(ur.rate * 100).toFixed(3)}% · ${ur.source}`,
          short: `ul rate ${(ur.rate * 100).toFixed(3)}%`,
        });
      } catch (urErr) {
        lines.push({ kind: 'info', msg: `Underlying rate: ${urErr instanceof Error ? urErr.message : 'failed'}. Enter manually.` });
      }
    } else {
      lines.push({ kind: 'info', msg: `No open rate source for ${underlyingCcy}. Set the underlying rate manually.` });
    }

    try {
      const fx = await fetchFxRealizedVolAndCorr(underlyingCcy, noteCcy, ticker);
      if (!isCurrent()) return { lines, volSource };
      const latest = useMarketStore.getState().market.quanto;
      useMarketStore.getState().setQuanto({
        rateUnderlying: latest?.rateUnderlying ?? cur?.rateUnderlying ?? 0,
        fxVol: fx.fxVol,
        corrEqFx: fx.corrEqFx,
      });
      lines.push({
        kind: 'ok',
        msg: `FX vol ${(fx.fxVol * 100).toFixed(1)}%, eq-FX corr ${fx.corrEqFx.toFixed(2)} · ${fx.source}`,
        short: `fx ${(fx.fxVol * 100).toFixed(1)}%/${fx.corrEqFx.toFixed(2)}`,
      });
    } catch (fxErr) {
      lines.push({
        kind: 'info',
        msg: `FX vol/correlation: ${fxErr instanceof Error ? fxErr.message : 'failed'}. Enter manually.`,
      });
    }
  }

  return { lines, volSource };
}

export function MarketPanel() {
  const market = useMarketStore((s) => s.market);
  const underlyingName = useMarketStore((s) => s.underlyingName);
  const manualOverride = useMarketStore((s) => s.manualOverride);
  const ticker = useMarketStore((s) => s.ticker);
  const underlyingCurrency = useMarketStore((s) => s.underlyingCurrency);
  const setMarket = useMarketStore((s) => s.setMarket);
  const setQuanto = useMarketStore((s) => s.setQuanto);
  const setUnderlying = useMarketStore((s) => s.setUnderlying);

  const assetType = useMarketStore((s) => s.assetType);
  const setAssetType = useMarketStore((s) => s.setAssetType);

  const [fetching, setFetching] = useState(false);
  const [fetchLines, setFetchLines] = useState<FetchLine[]>([]);
  const [volSource, setVolSource] = useState<VolSourceInfo | undefined>(undefined);
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
    const trade = useTradeStore.getState();
    const page = trade.activePage;
    const spec =
      page === 'coupon'
        ? trade.couponSpec
        : page === 'participation'
          ? trade.participationSpec
          : trade.accumulatorSpec;
    const { lines, volSource: vs } = await fetchLiveData(
      sym,
      market.currency,
      spec.tenorYears,
      market.rate,
      () => fetchGeneration.current === generation,
    );
    if (fetchGeneration.current !== generation) return; // superseded
    setFetchLines(lines);
    setVolSource(vs);
    setFetching(false);
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

  return (
    <div>
      <h3 className="sidebar-title">Market Data</h3>
      <div className="field-group">
        <SelectField
          label="Currency"
          value={market.currency}
          options={CURRENCIES.map((c) => ({ value: c, label: c }))}
          onChange={(v) => setMarket({ currency: v })}
        />
        <TickerSearch
          ticker={ticker}
          displayName={underlyingName}
          onPick={(m) => {
            setUnderlying(m.symbol, m.name, m.quoteType === 'INDEX' ? 'index' : 'share', m.currency);
            void handleFetchLive(m.symbol);
          }}
        />

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
          title="Fetches delayed spot, reference rate (EUR/USD), and options-implied vol + dividend yield (falling back to 1Y realized vol) in one go. Manual edits always override."
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
          <div className="status-line" title={volSource.note ?? volSource.label}>
            Source: {volSource.label}
            {volSource.note ? `. ${volSource.note}` : ''}
          </div>
        )}
        <NumericField
          label="Rate"
          value={Number((market.rate * 100).toFixed(4))}
          step={0.1}
          suffix="%"
          onChange={(v) => setMarket({ rate: v / 100 })}
        />
        <NumericField
          label="Dividend yield"
          value={Number((market.divYield * 100).toFixed(4))}
          step={0.1}
          suffix="%"
          onChange={(v) => setMarket({ divYield: v / 100 })}
        />

        {quantoMismatch && market.quanto && (
          <div className="field-group">
            <div className="field-label">
              <span>Quanto</span>
            </div>
            <NumericField
              label="Underlying rate"
              value={Number((market.quanto.rateUnderlying * 100).toFixed(4))}
              step={0.1}
              suffix="%"
              onChange={(v) => setQuanto({ ...market.quanto!, rateUnderlying: v / 100 })}
            />
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
         * signs deliberately differ — see CostParams in model/market.ts. */}
        <div className="field-group">
          <div className="field-label">
            <span>Costs</span>
            {costsActive && <span className="solved-badge">ON</span>}
          </div>
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
        </div>
      </div>
    </div>
  );
}
