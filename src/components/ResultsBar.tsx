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

function HistogramChart({ histogram }: { histogram: { binEdges: number[]; counts: number[] } }) {
  const max = Math.max(...histogram.counts, 1);
  return (
    <div className="bar-chart">
      {histogram.counts.map((c, i) => {
        const lo = histogram.binEdges[i];
        const hi = histogram.binEdges[i + 1];
        return (
          <div
            key={i}
            className="bar-cell"
            data-label={`${lo.toFixed(1)}–${hi.toFixed(1)}%: ${c.toLocaleString()} paths`}
          >
            <div className="bar" style={{ height: c > 0 ? `${Math.max(2, (c / max) * 100)}%` : '0%' }} />
          </div>
        );
      })}
    </div>
  );
}

export function ResultsBar() {
  const { running, progress, result, error, liveUnsolvable, expanded, toggleExpanded } = useResultsStore();

  if (!running && !result && !error) return null;

  const headlineValue =
    result?.solvedValue !== undefined ? result.solvedValue.toFixed(2) : result?.pvPct.toFixed(3);
  const headlineLabel = result?.solvedValue !== undefined ? 'Solved value' : 'PV %';

  // Latency readout: makes the path-cache warm-start speedup visible instead
  // of implicit. Solves show iteration count + warm/cold; a plain live price
  // (no solve target) has neither, so it just reads the elapsed time.
  const solveSpeedLabel =
    result?.solveIterations !== undefined
      ? `solved in ${result.elapsedMs} ms · ${result.solveIterations} iter${result.solveIterations === 1 ? '' : 's'} (${
          result.solveWarmStart ? 'warm' : 'cold'
        })`
      : result
        ? `priced in ${result.elapsedMs} ms`
        : undefined;

  return (
    <div className="results-bar">
      <div className="results-bar-row">
        {running && (
          <div className="progress-wrap">
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
            <span className="progress-label">
              {progress
                ? `${phaseLabel(progress.phase, progress.solveIteration)} · ${progress.pathsDone.toLocaleString()}/${progress.pathsTotal.toLocaleString()} paths`
                : 'Starting…'}
            </span>
            <button className="btn btn-danger btn-sm" type="button" onClick={cancelPricing}>
              Cancel
            </button>
          </div>
        )}

        {!running && error && <div className="status-line error">{error}</div>}

        {!running && result && (
          <>
            <div className={`results-headline ${liveUnsolvable ? 'stale' : ''}`}>
              <span className="value">{headlineValue}</span>
              <span className="label">{headlineLabel}</span>
              {result.preview && !liveUnsolvable && (
                <span className="live-badge" title="Reduced-path preview — settling to full precision">
                  live
                </span>
              )}
              {liveUnsolvable && (
                <span className="no-solution-hint" title={liveUnsolvable}>
                  no solution at current terms
                </span>
              )}
            </div>
            <div className="results-meta">
              <span>
                PV <b>{result.pvPct.toFixed(3)}%</b>
              </span>
              <span>
                stderr <b>±{result.stderrPct.toFixed(3)}%</b>
              </span>
              <span>
                elapsed <b>{(result.elapsedMs / 1000).toFixed(1)}s</b>
              </span>
              {solveSpeedLabel && <span className="solve-speed">{solveSpeedLabel}</span>}
            </div>
            <div className="results-spacer" />
            <button
              className={`chevron-btn ${expanded ? 'expanded' : ''}`}
              type="button"
              aria-label="Expand results"
              onClick={toggleExpanded}
            >
              ▲
            </button>
          </>
        )}
      </div>

      {!running && result && expanded && (
        <div className="results-detail">
          <div>
            <h4 className="detail-block-title">Present Value</h4>
            <div className="detail-stat-row">
              <span>PV (ccy)</span>
              <span>{result.pvCcy.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            </div>
            <div className="detail-stat-row">
              <span>PV %</span>
              <span>{result.pvPct.toFixed(3)}%</span>
            </div>
            <div className="detail-stat-row">
              <span>95% CI</span>
              <span>
                [{result.ci95Pct[0].toFixed(3)}, {result.ci95Pct[1].toFixed(3)}]
              </span>
            </div>
            {result.solvedValue !== undefined && (
              <div className="detail-stat-row">
                <span>Solved value</span>
                <span>{result.solvedValue.toFixed(3)}</span>
              </div>
            )}
          </div>

          {result.greeks && (
            <div>
              <h4 className="detail-block-title">Greeks</h4>
              <div className="detail-stat-row">
                <span>Delta %</span>
                <span>{result.greeks.deltaPct.toFixed(3)}</span>
              </div>
              <div className="detail-stat-row">
                <span>Vega %</span>
                <span>{result.greeks.vegaPct.toFixed(3)}</span>
              </div>
            </div>
          )}

          <div>
            <h4 className="detail-block-title">Diagnostics</h4>
            {result.diagnostics.kiProb !== undefined && (
              <div className="detail-stat-row">
                <span>P(KI)</span>
                <span>{(result.diagnostics.kiProb * 100).toFixed(1)}%</span>
              </div>
            )}
            {result.diagnostics.upsideKoProb !== undefined && (
              <div className="detail-stat-row">
                <span>P(upside KO)</span>
                <span>{(result.diagnostics.upsideKoProb * 100).toFixed(1)}%</span>
              </div>
            )}
            {result.diagnostics.koProb !== undefined && (
              <div className="detail-stat-row">
                <span>P(accumulator KO)</span>
                <span>{(result.diagnostics.koProb * 100).toFixed(1)}%</span>
              </div>
            )}
            {result.diagnostics.expectedLifeYears !== undefined && (
              <div className="detail-stat-row">
                <span>Expected life</span>
                <span>{result.diagnostics.expectedLifeYears.toFixed(2)}y</span>
              </div>
            )}
          </div>

          {result.diagnostics.callProb && result.diagnostics.callProb.length > 0 && (
            <div>
              <h4 className="detail-block-title">Call probability by period</h4>
              <BarChart values={result.diagnostics.callProb} labelPrefix="Period" />
            </div>
          )}

          {result.diagnostics.histogram && result.diagnostics.histogram.counts.length > 0 && (
            <div>
              <h4 className="detail-block-title">PV distribution</h4>
              <HistogramChart histogram={result.diagnostics.histogram} />
              <div className="detail-stat-row">
                <span>P(loss)</span>
                <span>
                  {result.diagnostics.pLoss !== undefined ? `${(result.diagnostics.pLoss * 100).toFixed(1)}%` : '—'}
                </span>
              </div>
              <div
                className="detail-stat-row"
                title={
                  result.diagnostics.expectedShortfall1 !== undefined
                    ? `ES(1%): ${result.diagnostics.expectedShortfall1.toFixed(2)}%`
                    : undefined
                }
              >
                <span>Expected Shortfall (5%)</span>
                <span>
                  {result.diagnostics.expectedShortfall5 !== undefined
                    ? `${result.diagnostics.expectedShortfall5.toFixed(2)}%`
                    : '—'}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
