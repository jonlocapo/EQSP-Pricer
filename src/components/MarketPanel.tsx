import { useEffect, useState } from 'react';
import { useMarketStore } from '../state/marketStore';
import { fetchSpot } from '../services/spotFetch';
import { fetchHistVol, fetchRefRate, REF_RATE_CCYS } from '../services/marketFetch';
import { fetchImpliedFromOptions } from '../services/impliedFetch';
import { useTradeStore } from '../state/tradeStore';
import { NumericField } from './NumericField';
import { SelectField } from './SelectField';
import { Segmented } from './Segmented';
import { TickerSearch } from './TickerSearch';

const CURRENCIES = ['EUR', 'USD', 'CHF', 'GBP', 'JPY'];

interface FetchLine {
  kind: 'ok' | 'err' | 'info';
  msg: string;
}

/**
 * One-shot live data fetch. Concurrently:
 *  - spot (Yahoo→Stooq) — also detects the underlying's trading currency
 *  - reference rate (€STR/SOFR) when the note ccy has an open source
 *  - options-implied div yield + ATM vol (CBOE), falling back to 1Y
 *    historical vol when the chain is unavailable
 * Applies whatever succeeded; reports each component's outcome loudly.
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

  if (spotR.status === 'fulfilled') {
    store.applyFetchedSpot(spotR.value.spot, spotR.value.source, spotR.value.asOf, spotR.value.currency);
    lines.push({ kind: 'ok', msg: `Spot ${spotR.value.spot} · ${spotR.value.source}` });
  } else {
    lines.push({ kind: 'err', msg: `Spot: ${spotR.reason instanceof Error ? spotR.reason.message : 'failed'}` });
  }

  if (rateR.status === 'fulfilled') {
    useMarketStore.setState((s) => ({ market: { ...s.market, rate: rateR.value.rate } }));
    lines.push({
      kind: 'ok',
      msg: `Rate ${(rateR.value.rate * 100).toFixed(3)}% · ${rateR.value.source} ${rateR.value.asOf}`,
    });
  } else {
    lines.push({ kind: 'err', msg: `Rate: ${rateR.reason instanceof Error ? rateR.reason.message : 'failed'}` });
  }

  if (impliedR.status === 'fulfilled') {
    const r = impliedR.value;
    useMarketStore.setState((s) => ({ market: { ...s.market, vol: r.atmVol, divYield: r.divYield } }));
    lines.push({
      kind: 'ok',
      msg:
        `Vol ${(r.atmVol * 100).toFixed(1)}%, div ${(r.divYield * 100).toFixed(2)}% · options ${r.expiry} K=${r.strike}` +
        (r.approximate ? ' (approx, American-style)' : ''),
    });
  } else {
    const impliedMsg = impliedR.reason instanceof Error ? impliedR.reason.message : 'failed';
    // Options chain unavailable — fall back to realized vol; div stays manual.
    try {
      const hv = await fetchHistVol(ticker);
      useMarketStore.setState((s) => ({ market: { ...s.market, vol: hv.vol } }));
      lines.push({ kind: 'ok', msg: `Vol ${(hv.vol * 100).toFixed(2)}% · ${hv.source} (realized fallback)` });
      lines.push({ kind: 'info', msg: `Options unavailable (${impliedMsg}) — div yield left as entered` });
    } catch (hvErr) {
      lines.push({ kind: 'err', msg: `Vol: options (${impliedMsg}); hist (${hvErr instanceof Error ? hvErr.message : 'failed'})` });
      lines.push({ kind: 'info', msg: 'Div yield left as entered' });
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

  // When a currency mismatch first appears, seed quanto params from the
  // current note rate; when it resolves (or the underlying ccy is unknown),
  // clear them so single-currency pricing is untouched.
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
            setUnderlying(m.symbol, m.name, m.quoteType === 'INDEX' ? 'index' : 'share');
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
        {fetchLines.map((l, i) => (
          <div key={i} className={`status-line ${l.kind === 'ok' ? 'ok' : l.kind === 'err' ? 'error' : ''}`}>
            {l.msg}
          </div>
        ))}
        {quantoMismatch && (
          <div className="status-line warn">
            {market.quanto
              ? 'Cross-currency note — quanto drift adjustment active.'
              : `Underlying trades in ${underlyingCurrency}, note in ${market.currency} — quanto/composite effects are NOT modeled; prices assume a single currency.`}
          </div>
        )}

        <div className="field">
          <div className="field-label">
            <span>Spot</span>
            {manualOverride && <span className="manual-badge">MANUAL</span>}
          </div>
          <div className="numeric-field">
            <input
              className="input"
              type="number"
              step={0.01}
              value={market.spot}
              onChange={(e) => setMarket({ spot: e.target.valueAsNumber })}
            />
          </div>
        </div>

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
            <span className="text-muted" style={{ fontSize: 11 }}>
              FX quoted as {market.currency} per {underlyingCurrency}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
