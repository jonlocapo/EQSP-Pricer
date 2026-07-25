import { useEffect, useState } from 'react';
import { useMarketStore } from '../state/marketStore';
import { fetchSpot } from '../services/spotFetch';
import { fetchFxRealizedVolAndCorr, fetchHistVol, fetchRefRate, REF_RATE_CCYS } from '../services/marketFetch';
import { fetchImpliedFromOptions } from '../services/impliedFetch';
import { useTradeStore } from '../state/tradeStore';
import { NumericField } from './NumericField';
import { SelectField } from './SelectField';
import { Segmented } from './Segmented';
import { TickerSearch } from './TickerSearch';
import { NO_COSTS, SUPPORTED_CURRENCIES as CURRENCIES, type CostParams } from '../model/market';
import { buildVolSurface, skewPoints, type VolSurface } from '../model/volSurface';

interface FetchLine {
  kind: 'ok' | 'err' | 'info';
  msg: string;
  /** Compact form used when rolling successful fetches into one summary line. */
  short?: string;
}

/**
 * One-shot live data fetch. Concurrently:
 *  - spot, Yahoo then Stooq — also detects the underlying's trading currency
 *  - reference rate (€STR/SOFR), when the note ccy has an open source
 *  - options-implied div yield and ATM vol (CBOE), falling back to 1Y
 *    historical vol when the chain is unavailable
 * Applies whatever succeeded, and reports each component's outcome loudly.
 */
async function fetchLiveData(
  ticker: string,
  noteCcy: string,
  tenorYears: number,
  rate: number,
): Promise<FetchLine[]> {
  const lines: FetchLine[] = [];
  const store = useMarketStore.getState();

  const spotP = fetchSpot(ticker);
  const rateP = (REF_RATE_CCYS as readonly string[]).includes(noteCcy)
    ? fetchRefRate(noteCcy)
    : Promise.reject(new Error(`no open rate source for ${noteCcy} — enter manually`));
  const impliedP = fetchImpliedFromOptions(ticker, tenorYears, rate);

  const [spotR, rateR, impliedR] = await Promise.allSettled([spotP, rateP, impliedP]);

  let underlyingCcy: string | undefined;
  if (spotR.status === 'fulfilled') {
    underlyingCcy = spotR.value.currency;
    store.applyFetchedSpot(spotR.value.spot, spotR.value.source, spotR.value.asOf, spotR.value.currency);
    lines.push({ kind: 'ok', msg: `Spot ${spotR.value.spot} · ${spotR.value.source}`, short: `spot ${spotR.value.spot}` });
  } else {
    lines.push({ kind: 'err', msg: `Spot: ${spotR.reason instanceof Error ? spotR.reason.message : 'failed'}` });
  }

  if (rateR.status === 'fulfilled') {
    useMarketStore.setState((s) => ({ market: { ...s.market, rate: rateR.value.rate } }));
    lines.push({
      kind: 'ok',
      msg: `Rate ${(rateR.value.rate * 100).toFixed(3)}% · ${rateR.value.source} ${rateR.value.asOf}`,
      short: `rate ${(rateR.value.rate * 100).toFixed(3)}%`,
    });
  } else {
    lines.push({ kind: 'err', msg: `Rate: ${rateR.reason instanceof Error ? rateR.reason.message : 'failed'}` });
  }

  if (impliedR.status === 'fulfilled') {
    const r = impliedR.value;
    // Keep the whole chain as a vol surface, not just the ATM number, so the
    // engine can price each product at its own risk strike. A chain too thin
    // to build a surface from is not an error. The ATM vol is still good.
    let surface: VolSurface | undefined;
    let surfaceMsg = '';
    try {
      surface = buildVolSurface(r.chain);
      const skew = skewPoints(surface, r.tYears, 80);
      surfaceMsg = ` · skew ${skew >= 0 ? '+' : ''}${(skew * 100).toFixed(1)}pt (80% vs ATM)`;
    } catch {
      surfaceMsg = ' · flat vol (chain too thin for a surface)';
    }
    useMarketStore.setState((s) => ({
      market: { ...s.market, vol: r.atmVol, divYield: r.divYield, volSurface: surface },
    }));
    lines.push({
      kind: 'ok',
      msg:
        `Vol ${(r.atmVol * 100).toFixed(1)}%, div ${(r.divYield * 100).toFixed(2)}% · options ${r.expiry} K=${r.strike}` +
        (r.approximate ? ' (approx, American-style)' : '') +
        surfaceMsg,
      short: `vol ${(r.atmVol * 100).toFixed(1)}%`,
    });
  } else {
    const impliedMsg = impliedR.reason instanceof Error ? impliedR.reason.message : 'failed';
    // Options chain unavailable. Fall back to realized vol; div stays manual.
    try {
      const hv = await fetchHistVol(ticker);
      // Clear any surface from a previous fetch. A realized vol is flat, and
      // keeping a stale surface would price this underlying on another one's
      // skew.
      useMarketStore.setState((s) => ({ market: { ...s.market, vol: hv.vol, volSurface: undefined } }));
      lines.push({
        kind: 'ok',
        msg: `Vol ${(hv.vol * 100).toFixed(2)}% · ${hv.source} (realized fallback)`,
        short: `vol ${(hv.vol * 100).toFixed(2)}%`,
      });
      lines.push({ kind: 'info', msg: `Options unavailable (${impliedMsg}) — div yield left as entered` });
    } catch (hvErr) {
      lines.push({ kind: 'err', msg: `Vol: options (${impliedMsg}); hist (${hvErr instanceof Error ? hvErr.message : 'failed'})` });
      lines.push({ kind: 'info', msg: 'Div yield left as entered' });
    }
  }

  // Cross-currency note: the quanto drift needs the UNDERLYING currency's
  // rate, not the note rate. Fetch it when there is a mismatch and an open
  // source exists. FX vol and Eq-FX correlation are auto-filled from Yahoo
  // 1Y realized FX/equity closes, best-effort; manual edits still override.
  if (underlyingCcy && underlyingCcy !== noteCcy) {
    const cur = useMarketStore.getState().market.quanto;
    if ((REF_RATE_CCYS as readonly string[]).includes(underlyingCcy)) {
      try {
        const ur = await fetchRefRate(underlyingCcy);
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
        lines.push({ kind: 'info', msg: `Underlying rate: ${urErr instanceof Error ? urErr.message : 'failed'} — enter manually` });
      }
    } else {
      lines.push({ kind: 'info', msg: `No open rate source for ${underlyingCcy} — set underlying rate manually` });
    }

    try {
      const fx = await fetchFxRealizedVolAndCorr(underlyingCcy, noteCcy, ticker);
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
        msg: `FX vol/correlation: ${fxErr instanceof Error ? fxErr.message : 'failed'} — enter manually`,
      });
    }
  }

  return lines;
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

  async function handleFetchLive(sym = ticker) {
    setFetching(true);
    setFetchLines([]);
    const trade = useTradeStore.getState();
    const page = trade.activePage;
    const spec =
      page === 'coupon'
        ? trade.couponSpec
        : page === 'participation'
          ? trade.participationSpec
          : trade.accumulatorSpec;
    const lines = await fetchLiveData(sym, market.currency, spec.tenorYears, market.rate);
    setFetchLines(lines);
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
              ? 'Cross-currency note — quanto drift adjustment active.'
              : `Underlying trades in ${underlyingCurrency}, note in ${market.currency} — quanto/composite effects are NOT modeled; prices assume a single currency.`}
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
