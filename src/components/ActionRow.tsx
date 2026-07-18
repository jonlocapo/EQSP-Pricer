import { createPortal } from 'react-dom';
import { useActionPortalNode } from './ActionPortalContext';

interface ActionRowProps {
  label: string;
  disabled: boolean;
  tooltip?: string;
  onRun: () => void;
  greeks: boolean;
  onGreeksChange: (v: boolean) => void;
  running: boolean;
}

/**
 * Renders nothing in place — its content is portaled into the results
 * panel's action slot (see ActionPortalContext) so the Price/Solve button
 * and greeks checkbox sit next to the result they produce. All state and
 * handlers are still owned entirely by the calling page.
 */
export function ActionRow({
  label,
  disabled,
  tooltip,
  onRun,
  greeks,
  onGreeksChange,
  running,
}: ActionRowProps) {
  const portalNode = useActionPortalNode();

  const content = (
    <div className="panel-action-row">
      <button
        type="button"
        className="btn btn-primary has-tooltip"
        disabled={disabled || running}
        data-tooltip={disabled ? tooltip : undefined}
        onClick={onRun}
      >
        {running ? 'Running…' : label}
      </button>
      <label className="panel-greeks-row">
        <input type="checkbox" checked={greeks} onChange={(e) => onGreeksChange(e.target.checked)} />
        Compute greeks (delta/vega)
      </label>
    </div>
  );

  if (!portalNode) return null;
  return createPortal(content, portalNode);
}
