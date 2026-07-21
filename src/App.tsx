import { useState } from 'react';
import { useTradeStore, type PageId } from './state/tradeStore';
import { useResultsStore } from './state/resultsStore';
import { MarketPanel } from './components/MarketPanel';
import { ResultsBar } from './components/ResultsBar';
import { HistoryModal } from './components/HistoryModal';
import { CouponPage } from './pages/CouponPage';
import { ParticipationPage } from './pages/ParticipationPage';
import { AccumulatorPage } from './pages/AccumulatorPage';
import { ProfilePage } from './pages/ProfilePage';

const TABS: { id: PageId; label: string }[] = [
  { id: 'coupon', label: 'Coupon (RC/AC)' },
  { id: 'participation', label: 'Participation' },
  { id: 'accumulator', label: 'Accumulator' },
];

export default function App() {
  const activePage = useTradeStore((s) => s.activePage);
  const setActivePage = useTradeStore((s) => s.setActivePage);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Profile is an analysis view layered over the three product pages, not
  // itself one of tradeStore's PageId — keeping it as separate UI-local
  // state avoids touching PageId (and everything keyed off it, e.g.
  // runPricing's history entries) just to add a non-trade tab.
  const [profileTab, setProfileTab] = useState(false);

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
              className={`tab-btn ${!profileTab && activePage === t.id ? 'active' : ''}`}
              onClick={() => {
                setActivePage(t.id);
                setProfileTab(false);
                useResultsStore.getState().setExpanded(false);
              }}
            >
              {t.label}
            </button>
          ))}
          <button
            type="button"
            className={`tab-btn ${profileTab ? 'active' : ''}`}
            onClick={() => setProfileTab(true)}
          >
            Profile
          </button>
        </nav>
        <div className="header-actions">
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
          {profileTab && <ProfilePage />}
          {!profileTab && activePage === 'coupon' && <CouponPage />}
          {!profileTab && activePage === 'participation' && <ParticipationPage />}
          {!profileTab && activePage === 'accumulator' && <AccumulatorPage />}
        </main>
      </div>

      <ResultsBar />
      {historyOpen && <HistoryModal onClose={() => setHistoryOpen(false)} />}
    </div>
  );
}
