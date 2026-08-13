import { useCallback, useState } from 'react';
import { useTradeStore, type PageId } from './state/tradeStore';
import { useResultsStore } from './state/resultsStore';
import { useAccent, useAccentShortcut } from './hooks/useAccent';
import { AccentPicker } from './components/AccentPicker';
import { MarketPanel } from './components/MarketPanel';
import { ResultsBar } from './components/ResultsBar';
import { HistoryModal } from './components/HistoryModal';
import { CouponPage } from './pages/CouponPage';
import { ParticipationPage } from './pages/ParticipationPage';
import { AccumulatorPage } from './pages/AccumulatorPage';
import { fullVersionLabel, shortVersionLabel } from './version';

const TABS: { id: PageId; label: string }[] = [
  { id: 'coupon', label: 'Coupon (RC/AC)' },
  { id: 'participation', label: 'Participation' },
  { id: 'accumulator', label: 'Accumulator' },
];

export default function App() {
  const activePage = useTradeStore((s) => s.activePage);
  const setActivePage = useTradeStore((s) => s.setActivePage);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [accentOpen, setAccentOpen] = useState(false);
  const { accentId, setAccentId } = useAccent();
  useAccentShortcut(useCallback(() => setAccentOpen((open) => !open), []));

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-title">
          <span className="dot" />
          EQSP Pricer
          {/* The build stamp. A static site redeploys silently, so the running
              version has to be readable from the page. The tooltip carries the
              commit, which identifies the exact build. */}
          <span className="app-version" title={fullVersionLabel()}>
            {shortVersionLabel()}
          </span>
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
          {/* The Contract Lab is HIDDEN, not deleted. The combinator engine
            * behind it stays built and tested (tests/lab.test.ts,
            * tests/combinators.test.ts), because the hand-written products are
            * pinned bit-identical against it. Only the launcher is gone, so
            * the app presents the three finished families and nothing
            * half-finished. Restore this button to bring it back. */}
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
      {accentOpen && (
        <AccentPicker accentId={accentId} onPick={setAccentId} onClose={() => setAccentOpen(false)} />
      )}
    </div>
  );
}
