import { useMemo, useState } from 'react';
import { useTradeStore, type PageId } from '../state/tradeStore';
import { useMarketStore } from '../state/marketStore';
import { Card } from '../components/Card';
import { Segmented } from '../components/Segmented';
import { NumericField } from '../components/NumericField';
import { pricerClient } from '../worker/client';
import type { ProfileProgressUpdate } from '../worker/client';
import type { ProfileRequest, ProfileResult } from '../worker/protocol';
import { DEFAULT_MC } from '../model/request';
import type { ProductSpec } from '../model/product';
import { buildChebyshevInterpolant } from '../engine/chebyshev';

const FAMILY_OPTIONS: { value: PageId; label: string }[] = [
  { value: 'coupon', label: 'Coupon (RC/AC)' },
  { value: 'participation', label: 'Participation' },
  { value: 'accumulator', label: 'Accumulator' },
];

interface DensePoint {
  spot: number;
  pv: number;
  delta: number;
  gamma: number;
}

/**
 * Minimal inline SVG line chart. Data-driven scaling (no external chart
 * lib), styled with the app's `.profile-chart-*` classes to match the
 * neon-periwinkle accent / flat-section visual language used elsewhere
 * (see ResultsBar's bar charts).
 */
function LineChart({
  points,
  yAccessor,
  markers,
  vLineX,
  height = 160,
  yLabel,
  yFormat = (v: number) => v.toFixed(3),
}: {
  points: DensePoint[];
  yAccessor: (p: DensePoint) => number;
  markers?: { x: number; y: number; title: string }[];
  vLineX: number;
  height?: number;
  yLabel: string;
  yFormat?: (v: number) => string;
}) {
  const width = 640;
  const xs = points.map((p) => p.spot);
  const ys = points.map(yAccessor);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMinRaw = Math.min(...ys);
  const yMaxRaw = Math.max(...ys);
  const yRangeRaw = yMaxRaw - yMinRaw;
  const magnitude = Math.max(Math.abs(yMaxRaw), Math.abs(yMinRaw), 1e-9);
  // Chebyshev differentiation faithfully differentiates whatever signal is
  // in the priced nodes — including floating-point round-off, which is all
  // that's left once real variation is many orders of magnitude below this
  // relative threshold (e.g. a genuinely spot-invariant PV% for a
  // percentage-quoted payoff: MC round-off at the node level, amplified by
  // two derivatives, still lands far below this floor). Auto-zooming the
  // y-axis into that noise would render a flat curve as a jagged mountain;
  // instead treat sub-floor variation as exactly flat and pad around the
  // mean by a fixed fraction of the curve's own magnitude.
  const NOISE_FLOOR_REL = 1e-6;
  // Delta/gamma differentiate whatever's in the nodes, including round-off;
  // when the whole series (not just its range) is already down at
  // round-off scale (~1e-10 or smaller — far below any real greek in this
  // app's units), the relative test above can't fire (both range and
  // magnitude are tiny together), so also floor on absolute magnitude.
  const ABS_FLOOR = 1e-6;
  const isFlat = yRangeRaw < NOISE_FLOOR_REL * magnitude || magnitude < ABS_FLOOR;
  const yMid = (yMaxRaw + yMinRaw) / 2;
  const yPad = isFlat ? Math.max(magnitude * 0.05, 1e-9) : yRangeRaw * 0.15;
  const yLo = isFlat ? yMid - yPad : yMinRaw - yPad;
  const yHi = isFlat ? yMid + yPad : yMaxRaw + yPad;

  const sx = (x: number) => ((x - xMin) / (xMax - xMin || 1)) * width;
  const sy = (y: number) => height - ((y - yLo) / (yHi - yLo || 1)) * height;

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.spot).toFixed(2)},${sy(yAccessor(p)).toFixed(2)}`).join(' ');
  const showVLine = vLineX >= xMin && vLineX <= xMax;
  const showZero = yLo < 0 && yHi > 0;

  return (
    <div className="profile-chart-block">
      <div className="profile-chart-title-row">
        <span className="profile-chart-ylabel">{yLabel}</span>
        <span className="profile-chart-range">
          {isFlat ? 'flat (within numerical noise)' : `[${yFormat(yMinRaw)}, ${yFormat(yMaxRaw)}]`}
        </span>
      </div>
      <svg className="profile-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        {showZero && <line className="profile-chart-zero" x1={0} y1={sy(0)} x2={width} y2={sy(0)} />}
        {showVLine && <line className="profile-chart-spot-line" x1={sx(vLineX)} y1={0} x2={sx(vLineX)} y2={height} />}
        <path className="profile-chart-line" d={path} fill="none" />
        {markers?.map((m, i) => (
          <circle key={i} className="profile-chart-node" cx={sx(m.x)} cy={sy(m.y)} r={2.5}>
            <title>{m.title}</title>
          </circle>
        ))}
      </svg>
      <div className="profile-chart-xaxis">
        <span>{xMin.toFixed(1)}</span>
        {showVLine && <span className="profile-chart-spot-label">S₀ = {vLineX.toFixed(2)}</span>}
        <span>{xMax.toFixed(1)}</span>
      </div>
    </div>
  );
}

export function ProfilePage() {
  const couponSpec = useTradeStore((s) => s.couponSpec);
  const participationSpec = useTradeStore((s) => s.participationSpec);
  const accumulatorSpec = useTradeStore((s) => s.accumulatorSpec);
  const market = useMarketStore((s) => s.market);

  const [family, setFamily] = useState<PageId>('coupon');
  const [N, setN] = useState(32);
  const [rangePct, setRangePct] = useState(50);

  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProfileProgressUpdate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profileResult, setProfileResult] = useState<ProfileResult | null>(null);

  const spec: ProductSpec =
    family === 'coupon' ? couponSpec : family === 'participation' ? participationSpec : accumulatorSpec;

  const interp = useMemo(() => {
    if (!profileResult) return null;
    const nodesX = profileResult.nodes.map((n) => n.spot);
    const nodesY = profileResult.nodes.map((n) => n.pvPct);
    return buildChebyshevInterpolant(nodesX, nodesY);
  }, [profileResult]);

  const dense = useMemo<DensePoint[] | null>(() => {
    if (!profileResult || !interp) return null;
    const { spotLo, spotHi } = profileResult;
    const M = 200;
    const pts: DensePoint[] = [];
    for (let i = 0; i < M; i++) {
      const spot = spotLo + ((spotHi - spotLo) * i) / (M - 1);
      pts.push({ spot, pv: interp.eval(spot), delta: interp.derivative(spot), gamma: interp.secondDerivative(spot) });
    }
    return pts;
  }, [profileResult, interp]);

  const nodeMarkersPv = profileResult?.nodes.map((n) => ({
    x: n.spot,
    y: n.pvPct,
    title: `spot ${n.spot.toFixed(2)}: PV ${n.pvPct.toFixed(3)}% (±${n.stderrPct.toFixed(3)}%)`,
  }));

  async function handleCompute() {
    const id = crypto.randomUUID();
    setRunId(id);
    setRunning(true);
    setError(null);
    setProgress(null);
    setProfileResult(null);
    const req: ProfileRequest = {
      id,
      product: spec,
      market,
      mc: DEFAULT_MC,
      N,
      rangeFrac: rangePct / 100,
    };
    try {
      const result = await pricerClient.profile(req, (p) => setProgress(p));
      setProfileResult(result);
    } catch (err) {
      if (!(err instanceof Error && err.message === 'cancelled')) {
        setError(err instanceof Error ? err.message : 'Profile computation failed.');
      }
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  function handleCancel() {
    if (runId) pricerClient.cancel(runId);
  }

  return (
    <div className="page-grid">
      <Card title="Price Profile — Chebyshev Surrogate">
        <p className="text-muted" style={{ fontSize: 12.5, margin: '0 0 4px' }}>
          Prices the product at N+1 Chebyshev nodes across a spot range (same MC seed/paths at every node, so the
          curve is smooth), then builds a barycentric interpolant. PV, delta, and gamma are all read off that
          interpolant instantly — delta/gamma come from ANALYTICALLY differentiating it, not from bump-and-reprice.
        </p>
        <div className="field">
          <div className="field-label">
            <span>Product family</span>
          </div>
          <Segmented<PageId> value={family} options={FAMILY_OPTIONS} onChange={setFamily} />
        </div>
        <div className="field-row">
          <NumericField label="Nodes (N)" value={N} step={1} min={4} max={64} onChange={(v) => setN(Math.round(v))} />
          <NumericField
            label="Spot range (±)"
            value={rangePct}
            step={5}
            min={5}
            max={200}
            suffix="%"
            onChange={setRangePct}
            hint={`≈ [${(market.spot * (1 - rangePct / 100)).toFixed(1)}, ${(market.spot * (1 + rangePct / 100)).toFixed(1)}]`}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 4 }}>
          <button type="button" className="btn btn-primary" disabled={running} onClick={handleCompute}>
            {running ? 'Computing…' : 'Compute profile'}
          </button>
          {running && (
            <button type="button" className="btn btn-danger btn-sm" onClick={handleCancel}>
              Cancel
            </button>
          )}
          {running && (
            <div className="progress-wrap" style={{ flex: 1 }}>
              <div className="progress-track">
                <div
                  className={`progress-fill ${!progress ? 'indeterminate' : ''}`}
                  style={progress ? { width: `${(progress.nodesDone / Math.max(1, progress.nodesTotal)) * 100}%` } : undefined}
                />
              </div>
              <span className="progress-label">
                {progress ? `Node ${progress.nodesDone}/${progress.nodesTotal}` : 'Starting…'}
              </span>
            </div>
          )}
        </div>
        {!running && error && <div className="status-line error">{error}</div>}
      </Card>

      {dense && profileResult && (
        <div style={{ gridColumn: '1 / -1' }} className="profile-charts-grid">
          <Card title="PV vs Spot">
            <LineChart points={dense} yAccessor={(p) => p.pv} markers={nodeMarkersPv} vLineX={market.spot} yLabel="PV %" />
          </Card>
          <Card title="Delta vs Spot (dPV/dspot)">
            <LineChart points={dense} yAccessor={(p) => p.delta} vLineX={market.spot} yLabel="Delta" yFormat={(v) => v.toFixed(4)} />
          </Card>
          <Card title="Gamma vs Spot (d²PV/dspot²)">
            <LineChart
              points={dense}
              yAccessor={(p) => p.gamma}
              vLineX={market.spot}
              yLabel="Gamma"
              yFormat={(v) => v.toExponential(2)}
            />
          </Card>
        </div>
      )}
    </div>
  );
}
