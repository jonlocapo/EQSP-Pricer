import { useMemo, useState } from 'react';
import { useHistoryStore, type HistoryEntry } from '../state/historyStore';
import { useMarketStore } from '../state/marketStore';
import { useTradeStore } from '../state/tradeStore';

interface HistoryModalProps {
  onClose: () => void;
}

const PAGE_LABEL: Record<HistoryEntry['page'], string> = {
  coupon: 'Coupon (RC/AC)',
  participation: 'Participation',
  accumulator: 'Accumulator',
};

export function HistoryModal({ onClose }: HistoryModalProps) {
  const entries = useHistoryStore((s) => s.entries);
  const restoreMarket = useMarketStore((s) => s.restoreMarket);
  const setActivePage = useTradeStore((s) => s.setActivePage);
  const replaceCouponSpec = useTradeStore((s) => s.replaceCouponSpec);
  const replaceParticipationSpec = useTradeStore((s) => s.replaceParticipationSpec);
  const replaceAccumulatorSpec = useTradeStore((s) => s.replaceAccumulatorSpec);
  const setCouponSolve = useTradeStore((s) => s.setCouponSolve);
  const setParticipationSolve = useTradeStore((s) => s.setParticipationSolve);
  const setAccumulatorSolve = useTradeStore((s) => s.setAccumulatorSolve);

  // Grouped by underlying, most-recently-used underlying first. `entries` is
  // already newest-first, so each group's first element is its newest run and
  // the within-group order needs no extra sorting.
  const groups = useMemo(() => {
    const byUnderlying = new Map<string, HistoryEntry[]>();
    for (const e of entries) {
      const key = e.underlyingName || '—';
      const existing = byUnderlying.get(key);
      if (existing) existing.push(e);
      else byUnderlying.set(key, [e]);
    }
    return [...byUnderlying.entries()].sort((a, b) => b[1][0].timestamp - a[1][0].timestamp);
  }, [entries]);

  // Collapsed rather than expanded state, so groups default to open and a
  // newly-created group doesn't start hidden.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  function toggleGroup(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function handleRestore(entry: HistoryEntry) {
    restoreMarket(entry.market, entry.underlyingName);
    if (entry.product.kind === 'coupon') {
      replaceCouponSpec(entry.product);
      setCouponSolve(entry.solve);
    } else if (entry.product.kind === 'participation') {
      replaceParticipationSpec(entry.product);
      setParticipationSolve(entry.solve);
    } else {
      replaceAccumulatorSpec(entry.product);
      setAccumulatorSolve(entry.solve);
    }
    setActivePage(entry.page);
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Run History</h2>
          <button className="btn btn-sm" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="modal-body">
          {entries.length === 0 ? (
            <div className="history-empty">No runs yet. Price a trade to see it here.</div>
          ) : (
            <table className="history-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Product</th>
                  <th>Terms</th>
                  <th>Market</th>
                  <th>Result</th>
                </tr>
              </thead>
              {groups.map(([underlying, rows]) => {
                const isCollapsed = collapsed.has(underlying);
                return (
                  <tbody key={underlying}>
                    <tr
                      className="history-group-row"
                      onClick={() => toggleGroup(underlying)}
                      aria-expanded={!isCollapsed}
                    >
                      <td colSpan={5}>
                        <button
                          type="button"
                          className={`history-group-arrow ${isCollapsed ? '' : 'open'}`}
                          aria-label={isCollapsed ? `Expand ${underlying}` : `Collapse ${underlying}`}
                          tabIndex={-1}
                        >
                          ▶
                        </button>
                        <b>{underlying}</b>
                        <span className="history-group-count">
                          {rows.length} run{rows.length === 1 ? '' : 's'}
                        </span>
                      </td>
                    </tr>
                    {!isCollapsed &&
                      rows.map((e) => (
                        <tr key={e.id} className="clickable" onClick={() => handleRestore(e)}>
                          <td>{new Date(e.timestamp).toLocaleString()}</td>
                          <td>
                            <span className="pill">{PAGE_LABEL[e.page]}</span>
                          </td>
                          <td>{e.termsSummary}</td>
                          <td>{e.marketSummary}</td>
                          <td>
                            {e.solvedValue !== undefined
                              ? `${e.solveLabel}: ${e.solvedValue.toFixed(2)}`
                              : `${e.pvPct.toFixed(3)}%`}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                );
              })}
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
