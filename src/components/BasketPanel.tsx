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
  const extraLegs = useMarketStore((s) => s.extraLegs);
  const [modalOpen, setModalOpen] = useState(false);

  const nLegs = 1 + extraLegs.length;

  // With one leg there is no worst-of yet, and nothing to summarise. A leg is
  // added from the `+` beside the ticker search, so this panel does not carry
  // a second, competing add button below it.
  if (nLegs < 2) return null;

  // The legs' own numbers are in the sidebar now, so this panel is down to
  // one job: opening the correlation editor. The names it used to summarise
  // are the chips on the ticker search, and the spots, volatilities and
  // dividends are the metric grids above. Repeating them cost the rows that
  // pushed a four-leg sidebar into a scrollbar.
  return (
    <>
      <button type="button" className="btn btn-sm" onClick={() => setModalOpen(true)} title="Per-pair correlations, and every leg's detail in one place.">
        Correlation
      </button>
      {modalOpen && <BasketModal onClose={() => setModalOpen(false)} onPickPrimary={onPickPrimary} />}
    </>
  );
}
