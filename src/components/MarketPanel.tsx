import { useState } from 'react';
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

function formatAsOf(asOf?: string): string {
  if (!asOf) return '';
  const d = new Date(asOf);
  if (Number.isNaN(d.getTime())) return asOf;
  return d.toLocaleString();
}

export function MarketPanel() {
  const market = useMarketStore((s) => s.market);
  const underlyingName = useMarketStore((s) => s.underlyingName);
  const fetchStatus = useMarketStore((s) => s.fetchStatus);
  const manualOverride = useMarketStore((s) => s.manualOverride);
  const ticker = useMarketStore((s) => s.ticker);
  const setMarket = useMarketStore((s) => s.setMarket);
  const setUnderlying = useMarketStore((s) => s.setUnderlying);
  const setFetchStatus = useMarketStore((s) => s.setFetchStatus);
  const applyFetchedSpot = useMarketStore((s) => s.applyFetchedSpot);

  const assetType = useMarketStore((s) => s.assetType);
  const setAssetType = useMarketStore((s) => s.setAssetType);

  const [fetching, setFetching] = useState(false);
  const [volStatus, setVolStatus] = useState<{ kind: 'idle' | 'busy' | 'ok' | 'err'; msg?: string }>({ kind: 'idle' });
  const [rateStatus, setRateStatus] = useState<{ kind: 'idle' | 'busy' | 'ok' | 'err'; msg?: string }>({ kind: 'idle' });

  async function handleEstVol() {
    setVolStatus({ kind: 'busy' });
    try {
      const res = await fetchHistVol(ticker);
      useMarketStore.setState((s) => ({ market: { ...s.market, vol: res.vol } }));
      setVolStatus({ kind: 'ok', msg: `${(res.vol * 100).toFixed(2)}% · ${res.source} (realized, not implied)` });
    } catch (err) {
      setVolStatus({ kind: 'err', msg: err instanceof Error ? err.message : 'Vol estimate unavailable' });
    }
  }

  async function handleFetchRate() {
    setRateStatus({ kind: 'busy' });
    try {
      const res = await fetchRefRate(market.currency);
      useMarketStore.setState((s) => ({ market: { ...s.market, rate: res.rate } }));
      setRateStatus({ kind: 'ok', msg: `${(res.rate * 100).toFixed(3)}% · ${res.source} · ${res.asOf}` });
    } catch (err) {
      setRateStatus({ kind: 'err', msg: err instanceof Error ? err.message : 'Rate unavailable' });
    }
  }

  const [implStatus, setImplStatus] = useState<{ kind: 'idle' | 'busy' | 'ok' | 'err'; msg?: string }>({ kind: 'idle' });

  async function handleImply() {
    setImplStatus({ kind: 'busy' });
    try {
      const trade = useTradeStore.getState();
      const page = trade.activePage;
      const spec =
        page === 'coupon'
          ? trade.couponSpec
          : page === 'participation'
            ? trade.participationDrafts[trade.participationSubtype]
            : trade.accumulatorSpec;
      const res = await fetchImpliedFromOptions(ticker, spec.tenorYears, market.rate);
      useMarketStore.setState((s) => ({
        market: { ...s.market, divYield: res.divYield, vol: res.atmVol, spot: res.spot },
      }));
      setImplStatus({
        kind: 'ok',
        msg:
          `q ${(res.divYield * 100).toFixed(2)}%, ATM IV ${(res.atmVol * 100).toFixed(1)}%, spot ${res.spot} · ` +
          `${res.expiry} K=${res.strike} · ${res.source}` +
          (res.approximate ? ' · approx (American-style options)' : ''),
      });
    } catch (err) {
      setImplStatus({ kind: 'err', msg: err instanceof Error ? err.message : 'Implied fetch failed' });
    }
  }

  async function handleFetch(sym = ticker) {
    setFetching(true);
    setFetchStatus({ state: 'loading' });
    try {
      const res = await fetchSpot(sym);
      applyFetchedSpot(res.spot, res.source, res.asOf);
    } catch (err) {
      setFetchStatus({
        state: 'error',
        message: err instanceof Error ? err.message : 'Fetch unavailable — enter spot manually',
      });
    } finally {
      setFetching(false);
    }
  }

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
            // Stale per-source statuses would mislead for the new underlying.
            setVolStatus({ kind: 'idle' });
            setImplStatus({ kind: 'idle' });
            void handleFetch(m.symbol);
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

        <button className="btn btn-sm" type="button" disabled={fetching} onClick={() => void handleFetch()}>
          {fetching ? 'Fetching…' : 'Fetch spot'}
        </button>
        {fetchStatus.state === 'ok' && (
          <div className="status-line ok">
            {fetchStatus.source} · {formatAsOf(fetchStatus.asOf)}
          </div>
        )}
        {fetchStatus.state === 'error' && (
          <div className="status-line error">{fetchStatus.message}</div>
        )}

        <NumericField
          label="Volatility"
          value={Number((market.vol * 100).toFixed(4))}
          step={0.5}
          suffix="%"
          onChange={(v) => setMarket({ vol: v / 100 })}
        />
        <button className="btn btn-sm" type="button" disabled={volStatus.kind === 'busy'} onClick={handleEstVol}>
          {volStatus.kind === 'busy' ? 'Estimating…' : 'Est. vol (1Y hist)'}
        </button>
        {volStatus.kind === 'ok' && <div className="status-line ok">{volStatus.msg}</div>}
        {volStatus.kind === 'err' && <div className="status-line error">{volStatus.msg}</div>}

        <NumericField
          label="Rate"
          value={Number((market.rate * 100).toFixed(4))}
          step={0.1}
          suffix="%"
          onChange={(v) => setMarket({ rate: v / 100 })}
        />
        {(REF_RATE_CCYS as readonly string[]).includes(market.currency) && (
          <button className="btn btn-sm" type="button" disabled={rateStatus.kind === 'busy'} onClick={handleFetchRate}>
            {rateStatus.kind === 'busy'
              ? 'Fetching…'
              : `Fetch ${market.currency === 'EUR' ? '€STR' : 'SOFR'}`}
          </button>
        )}
        {rateStatus.kind === 'ok' && <div className="status-line ok">{rateStatus.msg}</div>}
        {rateStatus.kind === 'err' && <div className="status-line error">{rateStatus.msg}</div>}
        <NumericField
          label="Dividend yield"
          value={Number((market.divYield * 100).toFixed(4))}
          step={0.1}
          suffix="%"
          onChange={(v) => setMarket({ divYield: v / 100 })}
        />
        <button
          className="btn btn-sm"
          type="button"
          disabled={implStatus.kind === 'busy'}
          onClick={handleImply}
          title="Implies forward dividend yield (put-call parity) and ATM vol from CBOE delayed option chains; also refreshes spot. US-listed underlyings only."
        >
          {implStatus.kind === 'busy' ? 'Implying…' : 'Imply div + vol (options)'}
        </button>
        {implStatus.kind === 'ok' && <div className="status-line ok">{implStatus.msg}</div>}
        {implStatus.kind === 'err' && <div className="status-line error">{implStatus.msg}</div>}
      </div>
    </div>
  );
}
