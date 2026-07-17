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
  const replaceParticipationDraft = useTradeStore((s) => s.replaceParticipationDraft);
  const replaceAccumulatorSpec = useTradeStore((s) => s.replaceAccumulatorSpec);
  const setCouponSolve = useTradeStore((s) => s.setCouponSolve);
  const setParticipationSolve = useTradeStore((s) => s.setParticipationSolve);
  const setAccumulatorSolve = useTradeStore((s) => s.setAccumulatorSolve);

  function handleRestore(entry: HistoryEntry) {
    restoreMarket(entry.market, entry.underlyingName);
    if (entry.product.kind === 'coupon') {
      replaceCouponSpec(entry.product);
      setCouponSolve(entry.solve);
    } else if (entry.product.kind === 'participation') {
      replaceParticipationDraft(entry.product);
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
              <tbody>
                {entries.map((e) => (
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
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
