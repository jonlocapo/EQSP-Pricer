import { useState } from 'react';
import type { MarketData } from '../model/market';
import type { ProductSpec } from '../model/product';
import type { PageId } from '../state/tradeStore';
import { ActionRow } from './ActionRow';
import { PricingGrid } from './PricingGrid';

interface PricingFooterProps {
  page: PageId;
  spec: ProductSpec;
  market: MarketData;
  underlyingName: string;
  priceLabel: string;
  priceDisabled: boolean;
  tooltip?: string;
  onRun: () => void;
  greeks: boolean;
  onGreeksChange: (v: boolean) => void;
  running: boolean;
}

/** The Price/Solve action row plus its collapsible pricing grid, identical
 * across every product page. Owns the grid-open toggle itself, since no page
 * reads that state back out; each page owns only the fields it prices with. */
export function PricingFooter({
  page,
  spec,
  market,
  underlyingName,
  priceLabel,
  priceDisabled,
  tooltip,
  onRun,
  greeks,
  onGreeksChange,
  running,
}: PricingFooterProps) {
  const [gridOpen, setGridOpen] = useState(false);

  return (
    <>
      <div style={{ gridColumn: '1 / -1' }}>
        <ActionRow
          label={priceLabel}
          disabled={priceDisabled}
          tooltip={tooltip}
          onRun={onRun}
          greeks={greeks}
          onGreeksChange={onGreeksChange}
          running={running}
          onToggleGrid={() => setGridOpen((v) => !v)}
          gridOpen={gridOpen}
        />
      </div>

      {gridOpen && (
        <div style={{ gridColumn: '1 / -1' }}>
          <PricingGrid page={page} spec={spec} market={market} underlyingName={underlyingName} />
        </div>
      )}
    </>
  );
}
