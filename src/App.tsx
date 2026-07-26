import { useCallback, useState } from 'react';
import { useTradeStore, type PageId } from './state/tradeStore';
import { useResultsStore } from './state/resultsStore';
import { useAccent, useAccentShortcut } from './hooks/useAccent';
import { AccentPicker } from './components/AccentPicker';
import { MarketPanel } from './components/MarketPanel';
import { ResultsBar } from './components/ResultsBar';
import { HistoryModal } from './components/HistoryModal';
import { LabModal } from './components/LabModal';
import { CouponPage } from './pages/CouponPage';
import { ParticipationPage } from './pages/ParticipationPage';
import { AccumulatorPage } from './pages/AccumulatorPage';

const TABS: { id: PageId; label: string }[] = [
  { id: 'coupon', label: 'Coupon (RC/AC)' },
  { id: 'participation', label: 'Participation' },
  { id: 'accumulator', label: 'Accumulator' },
];

export default function App() {
  const activePage = useTradeStore((s) => s.activePage);
  const setActivePage = useTradeStore((s) => s.setActivePage);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [labOpen, setLabOpen] = useState(false);
  const [accentOpen, setAccentOpen] = useState(false);
  const { accentId, setAccentId } = useAccent();
  useAccentShortcut(useCallback(() => setAccentOpen((open) => !open), []));

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-title">
          <span className="dot" />
          EQSP Pricer
        </div>
        <nav className="tab-bar">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tab-btn ${activePage === t.id ? 'active' : ''}`}
              onClick={() => {
                setActivePage(t.id);
                useResultsStore.getState().setExpanded(false);
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="header-actions">
          <button
            className="btn btn-sm lab-launch-btn"
            type="button"
            onClick={() => setLabOpen(true)}
            title="Contract Lab: build a payoff from blocks"
          >
            🧪 Lab
          </button>
          <button className="btn btn-sm" type="button" onClick={() => setHistoryOpen(true)}>
            History
          </button>
        </div>
      </header>

      <div className="app-body">
        <aside className="sidebar">
          <MarketPanel />
        </aside>
        <main className="main-area">
          {activePage === 'coupon' && <CouponPage />}
          {activePage === 'participation' && <ParticipationPage />}
          {activePage === 'accumulator' && <AccumulatorPage />}
        </main>
      </div>

      <ResultsBar />
      {historyOpen && <HistoryModal onClose={() => setHistoryOpen(false)} />}
      {labOpen && <LabModal onClose={() => setLabOpen(false)} />}
      {accentOpen && (
        <AccentPicker accentId={accentId} onPick={setAccentId} onClose={() => setAccentOpen(false)} />
      )}
    </div>
  );
}
