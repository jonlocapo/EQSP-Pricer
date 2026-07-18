import { useResultsStore } from '../state/resultsStore';
import { cancelPricing } from '../services/runPricing';

function phaseLabel(phase: string, solveIteration?: number): string {
  if (phase === 'solving') return `Solving${solveIteration ? ` · iter ${solveIteration}` : ''}`;
  if (phase === 'greeks') return 'Computing greeks';
  return 'Pricing';
}

function BarChart({ values, labelPrefix }: { values: number[]; labelPrefix: string }) {
  const max = Math.max(...values, 0.0001);
  return (
    <div className="bar-chart">
      {values.map((v, i) => (
        // Each column is a full-height flex cell that owns the hover/tooltip
        // target, so near-zero probabilities (a near-invisible bar) are
        // still fully hoverable across the column's whole height.
        <div key={i} className="bar-cell" data-label={`${labelPrefix} ${i + 1}: ${(v * 100).toFixed(1)}%`}>
          <div className="bar" style={{ height: v > 0 ? `${Math.max(2, (v / max) * 100)}%` : '0%' }} />
        </div>
      ))}
    </div>
  );
}

interface ResultsPanelProps {
  /** Ref callback wiring the portal target that ActionRow renders into. */
  actionSlotRef: (el: HTMLDivElement | null) => void;
}

export function ResultsPanel({ actionSlotRef }: ResultsPanelProps) {
  const { running, progress, result, error } = useResultsStore();

  const headlineValue =
    result?.solvedValue !== undefined ? result.solvedValue.toFixed(2) : result?.pvPct.toFixed(3);
  const headlineLabel = result?.solvedValue !== undefined ? 'Solved value' : 'PV %';

  return (
    <aside className="results-panel">
      {/* Price/Solve button + greeks checkbox are portaled here from the
          active page's ActionRow, so the action lives next to its result. */}
      <div className="panel-action-slot" ref={actionSlotRef} />

      {running && (
        <div className="panel-progress">
          <div className="progress-track">
            <div
              className={`progress-fill ${!progress ? 'indeterminate' : ''}`}
              style={
                progress
                  ? { width: `${Math.min(100, (progress.pathsDone / Math.max(1, progress.pathsTotal)) * 100)}%` }
                  : undefined
              }
            />
          </div>
          <span className="panel-progress-label">
            {progress
              ? `${phaseLabel(progress.phase, progress.solveIteration)} · ${progress.pathsDone.toLocaleString()}/${progress.pathsTotal.toLocaleString()} paths`
              : 'Starting…'}
          </span>
          <button className="btn btn-danger btn-sm" type="button" onClick={cancelPricing}>
            Cancel
          </button>
        </div>
      )}

      {!running && error && <div className="panel-error">{error}</div>}

      {!running && !result && !error && <div className="panel-idle">No pricing yet</div>}

      {!running && result && (
        <>
          <div className="panel-headline">
            <span className="label">{headlineLabel}</span>
            <span className="value">{headlineValue}</span>
            <span className="stderr">
              stderr ±{result.stderrPct.toFixed(3)}% · elapsed {(result.elapsedMs / 1000).toFixed(1)}s
            </span>
          </div>

          <div className="panel-stat-block">
            <div className="panel-stat-row">
              <span>PV (ccy)</span>
              <b>{result.pvCcy.toLocaleString(undefined, { maximumFractionDigits: 0 })}</b>
            </div>
            <div className="panel-stat-row">
              <span>PV %</span>
              <b>{result.pvPct.toFixed(3)}%</b>
            </div>
            <div className="panel-stat-row">
              <span>95% CI</span>
              <b>
                [{result.ci95Pct[0].toFixed(3)}, {result.ci95Pct[1].toFixed(3)}]
              </b>
            </div>
            {result.solvedValue !== undefined && (
              <div className="panel-stat-row">
                <span>Solved value</span>
                <b>{result.solvedValue.toFixed(3)}</b>
              </div>
            )}
          </div>

          {result.greeks && (
            <div className="panel-stat-block">
              <div className="panel-section-title">Greeks</div>
              <div className="panel-stat-row">
                <span>Delta %</span>
                <b>{result.greeks.deltaPct.toFixed(3)}</b>
              </div>
              <div className="panel-stat-row">
                <span>Vega %</span>
                <b>{result.greeks.vegaPct.toFixed(3)}</b>
              </div>
            </div>
          )}

          <div className="panel-stat-block">
            <div className="panel-section-title">Diagnostics</div>
            {result.diagnostics.kiProb !== undefined && (
              <div className="panel-stat-row">
                <span>P(KI)</span>
                <b>{(result.diagnostics.kiProb * 100).toFixed(1)}%</b>
              </div>
            )}
            {result.diagnostics.upsideKoProb !== undefined && (
              <div className="panel-stat-row">
                <span>P(upside KO)</span>
                <b>{(result.diagnostics.upsideKoProb * 100).toFixed(1)}%</b>
              </div>
            )}
            {result.diagnostics.koProb !== undefined && (
              <div className="panel-stat-row">
                <span>P(accumulator KO)</span>
                <b>{(result.diagnostics.koProb * 100).toFixed(1)}%</b>
              </div>
            )}
            {result.diagnostics.expectedLifeYears !== undefined && (
              <div className="panel-stat-row">
                <span>Expected life</span>
                <b>{result.diagnostics.expectedLifeYears.toFixed(2)}y</b>
              </div>
            )}
          </div>

          {result.diagnostics.callProb && result.diagnostics.callProb.length > 0 && (
            <div className="panel-stat-block">
              <div className="panel-section-title">Call probability by period</div>
              <BarChart values={result.diagnostics.callProb} labelPrefix="Period" />
            </div>
          )}
        </>
      )}
    </aside>
  );
}
