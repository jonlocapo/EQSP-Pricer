import { useEffect, useRef, useState } from 'react';
import type { ProductSpec } from '../model/product';
import type { MarketData } from '../model/market';
import type { SolveTarget } from '../model/request';
import type { PageId } from '../state/tradeStore';
import { gridParamsFor } from '../model/paramRegistry';
import {
  axisValues,
  betterDirection,
  gridToTsv,
  runGrid,
  shadeIntensity,
  solvableKinds,
  type GridCell,
  type GridCellState,
} from '../services/gridRun';
import { SOLVE_LABELS } from '../services/runPricing';
import { pricerClient } from '../worker/client';
import { NumericField } from './NumericField';
import { SelectField } from './SelectField';
import { nextStepValue } from './numericStep';
import { accumulatorTermsSummary, couponTermsSummary, marketSummary, participationTermsSummary } from '../services/summaries';

/** Solve targets offered per product kind, mirroring each page's own
 * per-field availability but flattened to one list for the setup dropdown.
 * A target only makes sense once the corresponding param exists in the
 * registry, so this list intentionally tracks paramRegistry.ts. */
const SOLVE_KINDS_BY_PAGE: Record<PageId, SolveTarget['kind'][]> = {
  coupon: ['none', 'couponPa', 'acCouponPa', 'couponBarrier', 'callBarrier', 'kiBarrier', 'putStrike'],
  participation: ['gearing', 'upsideStrike', 'bonusLevel', 'twinWin', 'upperStrike', 'upsideKoBarrier', 'rebate'],
  accumulator: ['strike', 'koTrigger', 'upfront'],
};

const DEFAULT_AXIS_COUNT = 5;
const MIN_AXIS_COUNT = 2;
const MAX_AXIS_COUNT = 10;

interface PricingGridProps {
  page: PageId;
  spec: ProductSpec;
  market: MarketData;
  underlyingName: string;
}

function termsSummaryFor(spec: ProductSpec): string {
  if (spec.kind === 'coupon') return couponTermsSummary(spec);
  if (spec.kind === 'participation') return participationTermsSummary(spec);
  if (spec.kind === 'accumulator') return accumulatorTermsSummary(spec);
  return 'lab contract';
}

function cellDisplay(state: GridCellState): { text: string; title?: string } {
  if (state.status === 'pending') return { text: '···' };
  if (state.status === 'solved') return { text: state.value.toFixed(3) };
  if (state.status === 'invalid') return { text: '-', title: state.reason };
  return { text: 'n/s', title: state.reason };
}

export function PricingGrid({ page, spec, market, underlyingName }: PricingGridProps) {
  const params = gridParamsFor(spec.kind);
  const solveKinds = SOLVE_KINDS_BY_PAGE[page];

  const [xKey, setXKey] = useState<string>(params[0]?.key ?? '');
  const [yKey, setYKey] = useState<string>(params[1]?.key ?? params[0]?.key ?? '');
  const [solveKind, setSolveKind] = useState<SolveTarget['kind']>(solveKinds[0] ?? 'none');

  const [xValues, setXValues] = useState<number[]>([]);
  const [yValues, setYValues] = useState<number[]>([]);
  const [cells, setCells] = useState<GridCell[][]>([]);
  const [hasGenerated, setHasGenerated] = useState(false);
  const [running, setRunning] = useState(false);
  const [completedCount, setCompletedCount] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copiedHint, setCopiedHint] = useState<string | null>(null);

  /** The spec and market the grid was actually built from. Compared by
   * reference against the live `spec`/`market` props to flag the grid as
   * stale the instant the form changes underneath it. Silently stale would
   * mean a grid that no longer matches the terms it claims to summarise. */
  const builtFromRef = useRef<{ spec: ProductSpec; market: MarketData; underlyingName: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const isStale = hasGenerated && builtFromRef.current !== null && (builtFromRef.current.spec !== spec || builtFromRef.current.market !== market);

  // A change of product page/kind invalidates any grid on screen; reseed the
  // param pickers and clear the built grid rather than show a mismatched one.
  useEffect(() => {
    setXKey(params[0]?.key ?? '');
    setYKey(params[1]?.key ?? params[0]?.key ?? '');
    // Pick a solve target the two default axes do not already occupy. The
    // accumulator would otherwise open with Strike on the X axis AND Strike as
    // the solve target, which is the exact contradiction the pickers exist to
    // prevent.
    const takenByDefaultAxes = [params[0]?.solveKind, params[1]?.solveKind].filter(Boolean);
    setSolveKind(solveKinds.find((k) => !takenByDefaultAxes.includes(k)) ?? solveKinds[0] ?? 'none');
    setHasGenerated(false);
    setCells([]);
    setXValues([]);
    setYValues([]);
    builtFromRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.kind]);

  const xParam = params.find((p) => p.key === xKey);
  const yParam = params.find((p) => p.key === yKey);
  const sameAxis = !!xKey && xKey === yKey;
  const solveTarget: SolveTarget = { kind: solveKind } as SolveTarget;
  const direction = betterDirection(solveTarget, spec);

  /**
   * The axis pickers and the solve-for picker must stay mutually exclusive.
   *
   * A field cannot be both an axis and the solve target. The solver WRITES the
   * target field, so it would overwrite the axis value that cell was supposed
   * to be priced at, and the header would name a level that never reached the
   * engine. Filtering both pickers makes that state unreachable rather than
   * merely discouraged.
   */
  function paramOptions(otherKey: string) {
    return params
      .filter((p) => p.key !== otherKey)
      .filter((p) => !p.solveKind || p.solveKind !== solveKind)
      .map((p) => ({ value: p.key, label: p.label }));
  }

  const axisSolveKinds = [xParam?.solveKind, yParam?.solveKind].filter(Boolean);
  const supported = solvableKinds(spec);
  const availableSolveKinds = solveKinds.filter((k) => supported.includes(k) && !axisSolveKinds.includes(k));

  // Belt and braces. The filtered pickers should make a conflicting selection
  // unreachable, but if any path ever lands on one, move off it rather than
  // solve for a field an axis is driving.
  useEffect(() => {
    if (availableSolveKinds.length > 0 && !availableSolveKinds.includes(solveKind)) {
      setSolveKind(availableSolveKinds[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableSolveKinds.join('|'), solveKind]);

  function cancel() {
    abortRef.current?.abort();
  }

  async function generate() {
    if (!xParam || !yParam || sameAxis) return;
    setErrorMessage(null);
    const nextX = axisValues(xParam.read(spec), xParam.step, xValues.length || DEFAULT_AXIS_COUNT);
    const nextY = axisValues(yParam.read(spec), yParam.step, yValues.length || DEFAULT_AXIS_COUNT);
    setXValues(nextX);
    setYValues(nextY);
    const pending: GridCell[][] = nextY.map((yValue, r) =>
      nextX.map((xValue, c) => ({ rowIndex: r, colIndex: c, xValue, yValue, state: { status: 'pending' as const } }))
    );
    setCells(pending);
    setHasGenerated(true);
    builtFromRef.current = { spec, market, underlyingName };
    setCompletedCount(0);

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    try {
      await runGrid({
        client: pricerClient,
        baseSpec: spec,
        market,
        xParam,
        yParam,
        xValues: nextX,
        yValues: nextY,
        solve: solveTarget,
        signal: controller.signal,
        onCell: (r, c, state) => {
          setCells((prev) => {
            const copy = prev.map((row) => row.slice());
            if (copy[r] && copy[r][c]) copy[r][c] = { ...copy[r][c], state };
            return copy;
          });
          setCompletedCount((n) => n + 1);
        },
      });
    } catch (err) {
      if (abortRef.current === controller) {
        setErrorMessage(err instanceof Error ? err.message : 'Grid pricing failed.');
      }
    } finally {
      // Only the CURRENT run may clear the shared run state. A superseded run
      // finishing late would otherwise null out its successor's controller and
      // report "not running" while that successor is still solving.
      if (abortRef.current === controller) {
        setRunning(false);
        abortRef.current = null;
      }
    }
  }

  /** Re-solves a single row or column after its header value changes, or
   * after an add-row/add-column. Runs through the same sequential `runGrid`
   * loop, restricted to the one axis value that changed, so it hits the same
   * warm path cache as everything else instead of a special-cased call. */
  async function resolveSlice(axis: 'row' | 'col', index: number, value: number) {
    if (!xParam || !yParam) return;
    setErrorMessage(null);
    // Supersede whatever slice run is still in flight. A header is a
    // NumericField, which commits on every keystroke, so typing "130" asks for
    // three re-solves in a row. Without this abort they all keep writing, and
    // the slowest one wins whichever cells it finishes last: a column that
    // reads partly from 130 and partly from the intermediate 1. Observed in a
    // browser as a column with one invalid cell and four stale ones.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    try {
      if (axis === 'row') {
        await runGrid({
          client: pricerClient,
          baseSpec: spec,
          market,
          xParam,
          yParam,
          xValues,
          yValues: [value],
          solve: solveTarget,
          signal: controller.signal,
          onCell: (_r, c, state) => {
            if (abortRef.current !== controller) return;
            setCells((prev) => {
              const copy = prev.map((row) => row.slice());
              if (copy[index] && copy[index][c]) copy[index][c] = { ...copy[index][c], state, yValue: value };
              return copy;
            });
          },
        });
      } else {
        await runGrid({
          client: pricerClient,
          baseSpec: spec,
          market,
          xParam,
          yParam,
          xValues: [value],
          yValues,
          solve: solveTarget,
          signal: controller.signal,
          onCell: (r, _c, state) => {
            // A superseded run must never write. `runGrid` only checks its
            // abort signal between cells, so a run aborted mid-cell can still
            // deliver that one cell, and it would land on top of the newer
            // run's answer.
            if (abortRef.current !== controller) return;
            setCells((prev) => {
              const copy = prev.map((row) => row.slice());
              if (copy[r] && copy[r][index]) copy[r][index] = { ...copy[r][index], state, xValue: value };
              return copy;
            });
          },
        });
      }
    } catch (err) {
      if (abortRef.current === controller) {
        setErrorMessage(err instanceof Error ? err.message : 'Grid pricing failed.');
      }
    } finally {
      // Only the CURRENT run may clear the shared run state. A superseded run
      // finishing late would otherwise null out its successor's controller and
      // report "not running" while that successor is still solving.
      if (abortRef.current === controller) {
        setRunning(false);
        abortRef.current = null;
      }
    }
  }

  /**
   * Waits for a header edit to settle before re-solving its slice.
   *
   * A header is a NumericField, and NumericField commits on every keystroke, so
   * typing "130" arrives as 1, then 13, then 130. Each one is a whole column of
   * solves. The abort in resolveSlice keeps the answers consistent, but firing
   * three runs to keep one is pure waste, and the intermediate values are not
   * anything the user asked to price. So collapse a burst into one run, the same
   * reasoning the main form's typing debounce uses (see hooks/useLiveReprice).
   */
  const HEADER_DEBOUNCE_MS = 260;
  const headerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function scheduleSlice(axis: 'row' | 'col', index: number, value: number) {
    if (!hasGenerated) return;
    if (headerTimer.current) clearTimeout(headerTimer.current);
    headerTimer.current = setTimeout(() => {
      headerTimer.current = null;
      void resolveSlice(axis, index, value);
    }, HEADER_DEBOUNCE_MS);
  }

  useEffect(() => {
    return () => {
      if (headerTimer.current) clearTimeout(headerTimer.current);
    };
  }, []);

  /**
   * Re-solves the whole grid when the question changes.
   *
   * Changing the solve target changes what EVERY cell means, so the old numbers
   * are answers to a question nobody is asking any more. Changing an axis
   * parameter is worse: the headers still hold values of the parameter the user
   * just moved away from. Re-shading alone would leave both cases showing a
   * confidently wrong table, so regenerate instead.
   *
   * This cannot loop: generate() never writes xKey, yKey or solveKind.
   */
  useEffect(() => {
    if (!hasGenerated) return;
    void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [solveKind, xKey, yKey]);

  function editColumnHeader(index: number, value: number) {
    setXValues((prev) => prev.map((v, i) => (i === index ? value : v)));
    scheduleSlice('col', index, value);
  }

  function editRowHeader(index: number, value: number) {
    setYValues((prev) => prev.map((v, i) => (i === index ? value : v)));
    scheduleSlice('row', index, value);
  }

  function addColumn() {
    if (!xParam || xValues.length >= MAX_AXIS_COUNT) return;
    const last = xValues[xValues.length - 1] ?? xParam.read(spec);
    const next = nextStepValue(last, xParam.step, 1);
    setXValues((prev) => [...prev, next]);
    if (hasGenerated) {
      setCells((prev) => prev.map((row, r) => [...row, { rowIndex: r, colIndex: row.length, xValue: next, yValue: yValues[r], state: { status: 'pending' as const } }]));
      void resolveSlice('col', xValues.length, next);
    }
  }

  function addRow() {
    if (!yParam || yValues.length >= MAX_AXIS_COUNT) return;
    const last = yValues[yValues.length - 1] ?? yParam.read(spec);
    const next = nextStepValue(last, yParam.step, 1);
    setYValues((prev) => [...prev, next]);
    if (hasGenerated) {
      setCells((prev) => [
        ...prev,
        xValues.map((x, c) => ({ rowIndex: prev.length, colIndex: c, xValue: x, yValue: next, state: { status: 'pending' as const } })),
      ]);
      void resolveSlice('row', yValues.length, next);
    }
  }

  function removeColumn(index: number) {
    if (xValues.length <= MIN_AXIS_COUNT) return;
    setXValues((prev) => prev.filter((_, i) => i !== index));
    setCells((prev) => prev.map((row) => row.filter((_, i) => i !== index)));
  }

  function removeRow(index: number) {
    if (yValues.length <= MIN_AXIS_COUNT) return;
    setYValues((prev) => prev.filter((_, i) => i !== index));
    setCells((prev) => prev.filter((_, i) => i !== index));
  }

  function copyCell(state: GridCellState) {
    if (state.status !== 'solved') return;
    navigator.clipboard.writeText(String(state.value)).catch(() => {
      // Clipboard access can be denied by the browser; there is nothing
      // useful to do beyond not throwing into the click handler.
    });
  }

  function copyGrid() {
    const tsv = gridToTsv(xValues, yValues, cells);
    navigator.clipboard
      .writeText(tsv)
      .then(() => {
        setCopiedHint('Copied.');
        setTimeout(() => setCopiedHint(null), 1500);
      })
      .catch(() => {
        // Same as copyCell: nothing useful to do on denial.
      });
  }

  // Shade only over the valid, solved cells, so one failure or an outlier
  // cannot flatten the scale for everything else.
  const solvedValues = cells.flat().flatMap((c) => (c.state.status === 'solved' ? [c.state.value] : []));
  const shadeMin = solvedValues.length ? Math.min(...solvedValues) : 0;
  const shadeMax = solvedValues.length ? Math.max(...solvedValues) : 0;

  const totalCells = xValues.length * yValues.length;

  return (
    <section className="card pricing-grid-panel">
      <h3 className="card-title">Pricing grid</h3>

      <div className="pricing-grid-setup">
        <SelectField label="X axis" value={xKey} options={paramOptions(yKey)} onChange={setXKey} />
        <SelectField label="Y axis" value={yKey} options={paramOptions(xKey)} onChange={setYKey} />
        <SelectField
          label="Solve for"
          value={solveKind}
          options={availableSolveKinds.map((k) => ({ value: k, label: SOLVE_LABELS[k] }))}
          onChange={(v) => setSolveKind(v as SolveTarget['kind'])}
        />
        <div className="pricing-grid-actions">
          <button
            type="button"
            className="btn btn-primary has-tooltip"
            disabled={running || sameAxis || !xParam || !yParam}
            data-tooltip={sameAxis ? 'X and Y must be different parameters.' : undefined}
            onClick={generate}
          >
            Generate
          </button>
          {running && (
            <button type="button" className="btn btn-danger btn-sm" onClick={cancel}>
              Cancel
            </button>
          )}
          {hasGenerated && (
            <button type="button" className="btn btn-sm" onClick={copyGrid} disabled={running}>
              {copiedHint ?? 'Copy grid as TSV'}
            </button>
          )}
        </div>
      </div>

      {sameAxis && <div className="page-banner error">X and Y axis must be different parameters.</div>}

      {running && (
        <div className="pricing-grid-progress">
          {totalCells > 0 ? `${Math.min(completedCount, totalCells)} of ${totalCells}` : 'Solving…'}
        </div>
      )}

      {errorMessage && <div className="status-line error">{errorMessage}</div>}

      {hasGenerated && builtFromRef.current && (
        <div className={`pricing-grid-basis ${isStale ? 'stale' : ''}`}>
          <span>
            Built from: {termsSummaryFor(builtFromRef.current.spec)} ·{' '}
            {marketSummary(builtFromRef.current.market, builtFromRef.current.underlyingName)}
          </span>
          {isStale && <span className="pricing-grid-stale-badge">Stale: terms changed since Generate</span>}
        </div>
      )}

      {!hasGenerated && !sameAxis && <div className="pricing-grid-empty">Pick two parameters and press Generate.</div>}

      {hasGenerated && (
        <div className="schedule-scroll pricing-grid-scroll">
          <table className="schedule-table pricing-grid-table">
            <thead>
              <tr>
                <th>
                  {yParam?.label} \ {xParam?.label}
                </th>
                {xValues.map((x, c) => (
                  <th key={c}>
                    <div className="pricing-grid-header">
                      <NumericField label="" value={x} step={xParam?.step ?? 1} suffix={xParam?.unit} onChange={(v) => editColumnHeader(c, v)} />
                      <button
                        type="button"
                        className="pricing-grid-remove"
                        aria-label="Remove column"
                        disabled={xValues.length <= MIN_AXIS_COUNT}
                        onClick={() => removeColumn(c)}
                      >
                        ×
                      </button>
                    </div>
                  </th>
                ))}
                <th>
                  <button type="button" className="btn btn-sm" onClick={addColumn} disabled={running || xValues.length >= MAX_AXIS_COUNT}>
                    + col
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {yValues.map((y, r) => (
                <tr key={r}>
                  <th>
                    <div className="pricing-grid-header">
                      <NumericField label="" value={y} step={yParam?.step ?? 1} suffix={yParam?.unit} onChange={(v) => editRowHeader(r, v)} />
                      <button
                        type="button"
                        className="pricing-grid-remove"
                        aria-label="Remove row"
                        disabled={yValues.length <= MIN_AXIS_COUNT}
                        onClick={() => removeRow(r)}
                      >
                        ×
                      </button>
                    </div>
                  </th>
                  {xValues.map((_, c) => {
                    const cell = cells[r]?.[c];
                    const state = cell?.state ?? { status: 'pending' as const };
                    const { text, title } = cellDisplay(state);
                    const intensity =
                      state.status === 'solved' ? shadeIntensity(state.value, shadeMin, shadeMax, direction) : 0;
                    const pct = Math.round(intensity * 85);
                    return (
                      <td
                        key={c}
                        title={title}
                        className={`pricing-grid-cell ${state.status}`}
                        style={
                          // An unshaded target (direction 'none') must leave the
                          // cell on the table's own background. Painting every
                          // cell the same accent-soft fill reads as a heatmap
                          // that failed, not as one deliberately withheld.
                          state.status === 'solved' && direction !== 'none'
                            ? {
                                backgroundColor: `color-mix(in srgb, var(--accent) ${pct}%, var(--accent-soft))`,
                                color: intensity > 0.55 ? 'var(--accent-contrast)' : undefined,
                              }
                            : undefined
                        }
                        onClick={() => copyCell(state)}
                      >
                        {text}
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr>
                <th>
                  <button type="button" className="btn btn-sm" onClick={addRow} disabled={running || yValues.length >= MAX_AXIS_COUNT}>
                    + row
                  </button>
                </th>
                {xValues.map((_, c) => (
                  <td key={c} />
                ))}
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
