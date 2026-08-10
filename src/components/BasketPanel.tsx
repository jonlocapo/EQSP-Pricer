import { useState } from 'react';
import { useMarketStore } from '../state/marketStore';
import { BasketModal } from './BasketModal';
import type { SymbolMatch } from '../services/symbolSearch';

interface Props {
  /** Picking a ticker for leg 1 (the primary underlying) has to run through
   * MarketPanel's own `handlePrimaryPick`: it also sets the note currency
   * and kicks off the live fetch, neither of which the modal owns. Legs 2
   * and up use the store's own `setLeg` directly, no callback needed. */
  onPickPrimary: (m: SymbolMatch) => void;
}

/**
 * The sidebar's entire footprint for a worst-of basket: a one-line summary
 * and an "Edit" button. Everything else — per-leg spot/vol/dividend,
 * the add-leg search, and the correlation editor — lives in `BasketModal`.
 *
 * A 260px sidebar column cannot hold a 3-column grid of names, ticker
 * badges and steppers without truncating every one of them (that is what
 * used to sit here). A summary line has nothing to truncate against: it is
 * ALLOWED to ellipsize, because the full names are one click away.
 *
 * Renders nothing when there is only one leg, so a plain single-underlying
 * trade stays visually simple, exactly as before.
 */
export function BasketPanel({ onPickPrimary }: Props) {
  const underlyingName = useMarketStore((s) => s.underlyingName);
  const extraLegs = useMarketStore((s) => s.extraLegs);
  const [modalOpen, setModalOpen] = useState(false);

  const nLegs = 1 + extraLegs.length;

  // With one leg there is no worst-of yet, so the sidebar shows nothing
  // beyond a single, quiet way to start one. The modal itself has the leg-1
  // tile plus the add-leg search regardless of leg count, so opening it
  // here is enough to go from one leg to two.
  if (nLegs < 2) {
    return (
      <div className="field-group">
        <button type="button" className="btn btn-sm" onClick={() => setModalOpen(true)}>
          + Add worst-of leg
        </button>
        {modalOpen && <BasketModal onClose={() => setModalOpen(false)} onPickPrimary={onPickPrimary} />}
      </div>
    );
  }

  const names = [underlyingName, ...extraLegs.map((l) => l.name || l.ticker || 'Unnamed leg')];

  return (
    <div className="field-group">
      <div className="field-label">
        <span>Basket</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="text-muted" style={{ fontSize: 11 }}>
            {nLegs} legs
          </span>
          <button type="button" className="btn btn-sm" onClick={() => setModalOpen(true)}>
            Edit
          </button>
        </span>
      </div>
      <div className="basket-summary-names" title={names.join(' · ')}>
        {names.join(' · ')}
      </div>
      {modalOpen && <BasketModal onClose={() => setModalOpen(false)} onPickPrimary={onPickPrimary} />}
    </div>
  );
}
