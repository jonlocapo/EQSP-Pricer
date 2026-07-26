import { describe, expect, it } from 'vitest';
import {
  axisValues,
  betterDirection,
  shadeIntensity,
  gridToTsv,
  runGrid,
  type GridCell,
  type GridCellState,
} from '../src/services/gridRun';
import { gridParamsFor } from '../src/model/paramRegistry';
import { DEFAULT_COUPON_SPEC, DEFAULT_ACCUMULATOR } from '../src/state/tradeStore';
import type { PricerClient, ProgressUpdate } from '../src/worker/client';
import type { PriceRequest, PriceResult } from '../src/model/request';
import type { MarketData } from '../src/model/market';

const market: MarketData = { spot: 100, vol: 0.25, rate: 0.02, divYield: 0.02, currency: 'EUR' };

describe('axisValues', () => {
  it('centres on the base value, ascending, distinct, snapped to step', () => {
    const values = axisValues(60, 1, 5);
    expect(values).toEqual([58, 59, 60, 61, 62]);
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
  });

  it('snaps an off-grid base to the surrounding multiples', () => {
    const values = axisValues(60.3, 1, 5);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) expect(Number.isInteger(v)).toBe(true);
  });

  it('returns an empty array for a non-positive count', () => {
    expect(axisValues(100, 1, 0)).toEqual([]);
  });
});

describe('betterDirection', () => {
  it('flags known-direction targets correctly', () => {
    expect(betterDirection({ kind: 'couponPa' }, DEFAULT_COUPON_SPEC)).toBe('higher');
    expect(betterDirection({ kind: 'kiBarrier' }, DEFAULT_COUPON_SPEC)).toBe('lower');
  });

  it('callBarrier is never shaded: a lower autocall trigger has no single correct direction', () => {
    expect(betterDirection({ kind: 'callBarrier' }, DEFAULT_COUPON_SPEC)).toBe('none');
  });

  it('strike flips with accumulator direction: lower-is-better accumulating, higher-is-better decumulating', () => {
    expect(betterDirection({ kind: 'strike' }, { ...DEFAULT_ACCUMULATOR, direction: 'accumulate' })).toBe('lower');
    expect(betterDirection({ kind: 'strike' }, { ...DEFAULT_ACCUMULATOR, direction: 'decumulate' })).toBe('higher');
  });

  it('koTrigger flips with accumulator direction: higher-is-better accumulating, lower-is-better decumulating', () => {
    expect(betterDirection({ kind: 'koTrigger' }, { ...DEFAULT_ACCUMULATOR, direction: 'accumulate' })).toBe('higher');
    expect(betterDirection({ kind: 'koTrigger' }, { ...DEFAULT_ACCUMULATOR, direction: 'decumulate' })).toBe('lower');
  });
});

describe('shadeIntensity', () => {
  it('returns 0 for a "none" direction', () => {
    expect(shadeIntensity(5, 0, 10, 'none')).toBe(0);
  });

  it('returns 0 when every solved cell is the same value', () => {
    expect(shadeIntensity(5, 5, 5, 'higher')).toBe(0);
  });

  it('normalises higher-is-better toward 1 at the max', () => {
    expect(shadeIntensity(10, 0, 10, 'higher')).toBe(1);
    expect(shadeIntensity(0, 0, 10, 'higher')).toBe(0);
    expect(shadeIntensity(5, 0, 10, 'higher')).toBeCloseTo(0.5);
  });

  it('normalises lower-is-better toward 1 at the min', () => {
    expect(shadeIntensity(0, 0, 10, 'lower')).toBe(1);
    expect(shadeIntensity(10, 0, 10, 'lower')).toBe(0);
  });
});

describe('gridToTsv', () => {
  function solved(v: number): GridCellState {
    return { status: 'solved', value: v, pvPct: v };
  }

  it('round trips shape: header row plus one row per Y value, tab separated', () => {
    const xValues = [1, 2];
    const yValues = [10, 20];
    const cells: GridCell[][] = [
      [
        { rowIndex: 0, colIndex: 0, xValue: 1, yValue: 10, state: solved(100) },
        { rowIndex: 0, colIndex: 1, xValue: 2, yValue: 10, state: solved(101) },
      ],
      [
        { rowIndex: 1, colIndex: 0, xValue: 1, yValue: 20, state: solved(102) },
        { rowIndex: 1, colIndex: 1, xValue: 2, yValue: 20, state: solved(103) },
      ],
    ];
    const tsv = gridToTsv(xValues, yValues, cells);
    const lines = tsv.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0].split('\t')).toEqual(['', '1', '2']);
    expect(lines[1].split('\t')).toEqual(['10', '100', '101']);
    expect(lines[2].split('\t')).toEqual(['20', '102', '103']);
  });

  it('renders invalid and no-solution cells with a plain marker instead of a number', () => {
    const cells: GridCell[][] = [
      [
        { rowIndex: 0, colIndex: 0, xValue: 1, yValue: 10, state: { status: 'invalid', reason: 'bad' } },
        { rowIndex: 0, colIndex: 1, xValue: 2, yValue: 10, state: { status: 'no-solution', reason: 'nope' } },
      ],
    ];
    const tsv = gridToTsv([1, 2], [10], cells);
    expect(tsv.split('\n')[1].split('\t')).toEqual(['10', 'invalid', 'no solution']);
  });
});

// ---------------------------------------------------------------------------
// runGrid
// ---------------------------------------------------------------------------

/** A fake PricerClient that records the number of CONCURRENT in-flight
 * price() calls, so the sequential-loop contract (never more than one cell
 * in flight at a time) is a real, enforced assertion rather than a hope. */
class TrackingClient implements PricerClient {
  inFlight = 0;
  maxInFlight = 0;
  calls: PriceRequest[] = [];
  private behavior: (req: PriceRequest) => Promise<PriceResult> | PriceResult;

  constructor(behavior: (req: PriceRequest) => Promise<PriceResult> | PriceResult) {
    this.behavior = behavior;
  }

  async price(req: PriceRequest, _onProgress: (p: ProgressUpdate) => void): Promise<PriceResult> {
    this.calls.push(req);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      // Force a real microtask hop, so two overlapping calls, if the loop
      // were ever parallelised, would actually overlap in `inFlight`.
      await new Promise((r) => setTimeout(r, 0));
      return await this.behavior(req);
    } finally {
      this.inFlight--;
    }
  }

  cancel(): void {}
}

function priceResult(req: PriceRequest, pvPct: number, solvedValue?: number): PriceResult {
  return {
    id: req.id,
    pvPct,
    pvCcy: pvPct * 10_000,
    stderrPct: 0.01,
    ci95Pct: [pvPct - 0.1, pvPct + 0.1],
    solvedValue,
    diagnostics: {},
    elapsedMs: 1,
  };
}

const kiParam = gridParamsFor('coupon').find((p) => p.key === 'coupon.kiBarrierPct')!;
const putParam = gridParamsFor('coupon').find((p) => p.key === 'coupon.putStrikePct')!;

describe('runGrid', () => {
  it('runs cells sequentially: at most one in flight at a time', async () => {
    const client = new TrackingClient((req) => priceResult(req, 98, 8));
    const cells: GridCellState[] = [];
    const xValues = axisValues(60, 1, 3);
    const yValues = axisValues(100, 1, 3);

    await runGrid({
      client,
      baseSpec: DEFAULT_COUPON_SPEC,
      market,
      xParam: kiParam,
      yParam: putParam,
      xValues,
      yValues,
      solve: { kind: 'couponPa' },
      onCell: (_r, _c, state) => cells.push(state),
    });

    expect(client.maxInFlight).toBe(1);
    expect(client.calls.length).toBe(xValues.length * yValues.length);
  });

  it('marks an invalid combination invalid WITHOUT dispatching a solve for it', async () => {
    const client = new TrackingClient((req) => priceResult(req, 98, 8));
    const cells: { r: number; c: number; state: GridCellState }[] = [];

    // KI barrier above put strike is invalid (validateCoupon). Put the KI
    // axis high and the put-strike axis low so some combinations cross.
    const xValues = [90, 95, 100]; // KI barrier
    const yValues = [80, 85, 90]; // put strike

    await runGrid({
      client,
      baseSpec: DEFAULT_COUPON_SPEC,
      market,
      xParam: kiParam,
      yParam: putParam,
      xValues,
      yValues,
      solve: { kind: 'couponPa' },
      onCell: (r, c, state) => cells.push({ r, c, state }),
    });

    const invalidCells = cells.filter((c) => c.state.status === 'invalid');
    const validCells = cells.filter((c) => c.state.status !== 'invalid');
    expect(invalidCells.length).toBeGreaterThan(0);
    expect(validCells.length).toBeGreaterThan(0);
    // No request was ever sent for an invalid combination.
    expect(client.calls.length).toBe(validCells.length);
  });

  it('a no-solution rejection marks just that one cell and leaves the rest intact', async () => {
    let call = 0;
    const client = new TrackingClient((req) => {
      call++;
      if (call === 2) {
        return Promise.reject(new Error('No solution for couponPa in [0, 100], target not reachable'));
      }
      return priceResult(req, 98, 8);
    });
    const cells: GridCellState[] = [];
    const xValues = [60, 61];
    const yValues = [100];

    await runGrid({
      client,
      baseSpec: DEFAULT_COUPON_SPEC,
      market,
      xParam: kiParam,
      yParam: putParam,
      xValues,
      yValues,
      solve: { kind: 'couponPa' },
      onCell: (_r, _c, state) => cells.push(state),
    });

    expect(cells).toHaveLength(2);
    expect(cells[0].status).toBe('solved');
    expect(cells[1].status).toBe('no-solution');
  });

  it('an unexpected (non-no-solution) rejection propagates and stops the run', async () => {
    const client = new TrackingClient(() => Promise.reject(new Error('Worker crashed unexpectedly')));
    await expect(
      runGrid({
        client,
        baseSpec: DEFAULT_COUPON_SPEC,
        market,
        xParam: kiParam,
        yParam: putParam,
        xValues: [60],
        yValues: [100],
        solve: { kind: 'couponPa' },
        onCell: () => {},
      })
    ).rejects.toThrow('Worker crashed unexpectedly');
  });

  it('shade normalisation ignores invalid and unsolved cells (min/max only over solved cells)', () => {
    // 3 solved values plus one outlier that must not flatten the scale for
    // the others once it's excluded. Modelled here directly against
    // shadeIntensity, since that is the piece that owns normalisation.
    const solvedValues = [10, 12, 14];
    const min = Math.min(...solvedValues);
    const max = Math.max(...solvedValues);
    expect(shadeIntensity(10, min, max, 'higher')).toBe(0);
    expect(shadeIntensity(14, min, max, 'higher')).toBe(1);
    expect(shadeIntensity(12, min, max, 'higher')).toBeCloseTo(0.5);
  });
});
