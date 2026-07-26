interface ActionRowProps {
  label: string;
  disabled: boolean;
  tooltip?: string;
  onRun: () => void;
  greeks: boolean;
  onGreeksChange: (v: boolean) => void;
  running: boolean;
  /** Toggles the inline pricing grid panel below the form. Omit to hide the
   * grid button entirely, for pages that do not offer one. */
  onToggleGrid?: () => void;
  gridOpen?: boolean;
}

export function ActionRow({
  label,
  disabled,
  tooltip,
  onRun,
  greeks,
  onGreeksChange,
  running,
  onToggleGrid,
  gridOpen,
}: ActionRowProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 4 }}>
      <button
        type="button"
        className="btn btn-primary has-tooltip"
        disabled={disabled || running}
        data-tooltip={disabled ? tooltip : undefined}
        onClick={onRun}
      >
        {running ? 'Running…' : label}
      </button>
      {onToggleGrid && (
        <button
          type="button"
          className={`btn btn-sm has-tooltip ${gridOpen ? 'btn-active' : ''}`}
          aria-pressed={gridOpen}
          data-tooltip="Pricing grid: solve every combination of two parameters at once."
          onClick={onToggleGrid}
        >
          <span aria-hidden="true" style={{ marginRight: 5 }}>
            ▦
          </span>
          Grid
        </button>
      )}
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-muted)' }}>
        <input type="checkbox" checked={greeks} onChange={(e) => onGreeksChange(e.target.checked)} />
        Compute greeks (delta/vega)
      </label>
    </div>
  );
}
