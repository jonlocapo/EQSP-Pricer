interface ActionRowProps {
  label: string;
  disabled: boolean;
  tooltip?: string;
  onRun: () => void;
  greeks: boolean;
  onGreeksChange: (v: boolean) => void;
  running: boolean;
}

export function ActionRow({
  label,
  disabled,
  tooltip,
  onRun,
  greeks,
  onGreeksChange,
  running,
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
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-muted)' }}>
        <input type="checkbox" checked={greeks} onChange={(e) => onGreeksChange(e.target.checked)} />
        Compute greeks (delta/vega)
      </label>
    </div>
  );
}
