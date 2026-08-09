/**
 * The pricing grid's run logic: axis generation, per-cell validation and
 * shading, and the run loop that turns two axes into a grid of independent
 * solves. Kept free of React and free of the singleton `pricerClient`, so a
 * test can drive it against a fake `PricerClient` with no worker at all.
 *
 * IMPORTANT: do not parallelise the cell loop. See runGrid below for why.
 */

import type { GridParam } from '../model/paramRegistry';
import type { ProductSpec } from '../model/product';
import type { MarketData } from '../model/market';
import type { PriceRequest, SolveTarget } from '../model/request';
import type { PricerClient, ProgressUpdate } from '../worker/client';
import { DEFAULT_MC } from '../model/request';
import { nextStepValue } from '../components/numericStep';
import { validateAccumulator, validateCoupon, validateParticipation } from './validation';
import { NO_SOLUTION_RE } from './runPricing';

/**
 * One axis's values, centred on the parameter's current value in the base
 * spec and stepped outward, ascending. Snapped to multiples of `step` with
 * `nextStepValue`, the same rounding NumericField's arrows use, so a grid
 * header always lands on the same tidy numbers the form would show.
 *
 * `count` is the number of cells on the axis. An odd count centres exactly
 * on `base`; an even count has one extra step on the high side, so the
 * sequence stays strictly ascending with no duplicate near `base`.
 */
export function axisValues(base: number, step: number, count: number): number[] {
  if (count <= 0) return [];
  const belowCount = Math.floor((count - 1) / 2);
  const values: number[] = [];
  let v = base;
  for (let i = 0; i < belowCount; i++) {
    v = nextStepValue(v, step, -1);
  }
  values.push(Number(v.toFixed(10)));
  for (let i = 1; i < count; i++) {
    v = nextStepValue(v, step, 1);
    values.push(Number(v.toFixed(10)));
  }
  return values;
}

/**
 * The solve targets the CURRENT terms can actually reach.
 *
 * Offering a target the spec cannot support fills the whole grid with "no
 * solution": solving for a call barrier means nothing when the note has no call
 * schedule. The product pages already gate their SOLVE chips this way (see
 * `canCallBarrier` and friends in pages/CouponPage.tsx), so the grid applies
 * the same rules rather than offering a choice that cannot work.
 */
export function solvableKinds(spec: ProductSpec): SolveTarget['kind'][] {
  if (spec.kind === 'coupon') {
    // Under issuerCallable the engine prices by LSMC and solves for nothing.
    if (spec.callType === 'issuerCallable') return ['none'];
    const kinds: SolveTarget['kind'][] = ['none', 'couponPa', 'putStrike'];
    if (spec.acCouponType !== 'none') kinds.push('acCouponPa');
    if (spec.couponType !== 'fixed') kinds.push('couponBarrier');
    if (spec.callType === 'constant' || spec.callType === 'stepdown') kinds.push('callBarrier');
    if (spec.barrierType !== 'none') kinds.push('kiBarrier');
    return kinds;
  }
  if (spec.kind === 'participation') {
    const kinds: SolveTarget['kind'][] = ['none', 'gearing', 'upsideStrike'];
    if (spec.upside.variant.variant === 'callSpread') kinds.push('upperStrike');
    if (spec.upside.variant.variant === 'koRebate') kinds.push('upsideKoBarrier', 'rebate');
    // A bonus and a twin-win both depend on the knock-in condition, so neither
    // is solvable while the downside leg is always live.
    if (spec.downside.barrierType !== 'none') kinds.push('bonusLevel', 'twinWin');
    return kinds;
  }
  if (spec.kind === 'accumulator') return ['strike', 'upfront', 'koTrigger'];
  return ['none'];
}

/**
 * The client's-eye direction for a solve target: does a HIGHER solved value
 * read as better value, or a LOWER one? Cells shade from this, darker toward
 * "better". Returns 'none' when there is no single correct direction, so the
 * grid renders that target unshaded rather than implying a preference that
 * is not really there.
 */
export function betterDirection(target: SolveTarget, spec: ProductSpec): 'higher' | 'lower' | 'none' {
  switch (target.kind) {
    case 'couponPa':
    case 'acCouponPa':
    case 'gearing':
    case 'bonusLevel':
    case 'rebate':
    case 'twinWin':
    case 'upperStrike':
      return 'higher';
    case 'kiBarrier':
    case 'putStrike':
    case 'couponBarrier':
    case 'upsideStrike':
    case 'upfront':
      return 'lower';
    case 'callBarrier':
      // A lower autocall trigger returns capital sooner but ends the coupon
      // stream sooner too. Neither outcome is objectively better for the
      // client, so this target is never shaded.
      return 'none';
    case 'strike':
      // The sign genuinely flips with direction: accumulating buys shares AT
      // the strike, so a lower strike is a better entry price. Decumulating
      // sells shares at the strike, so a higher strike is a better exit
      // price.
      if (spec.kind !== 'accumulator') return 'none';
      return spec.direction === 'accumulate' ? 'lower' : 'higher';
    case 'koTrigger':
      // Accumulating: the trigger sits above spot, so a higher trigger gives
      // more room before knock-out, which is better for the client.
      // Decumulating: the trigger sits below spot, so a lower trigger gives
      // more room, and is the better one there.
      if (spec.kind !== 'accumulator') return 'none';
      return spec.direction === 'accumulate' ? 'higher' : 'lower';
    case 'upsideKoBarrier':
      // Not one of the directions the spec calls out explicitly. A higher KO
      // barrier delays the knock-out, which sounds strictly better, but that
      // KO also carries a rebate whose relative attractiveness depends on
      // level, so there is no single clean direction here either. Leave it
      // unshaded rather than guess.
      return 'none';
    case 'none':
      // Not a solve at all: the cell holds the PRICE, a PV as a percent of
      // notional. A higher PV means the note is worth more for the reoffer the
      // client pays, so higher is better on the client frame this whole table
      // uses.
      return 'higher';
  }
}

/**
 * Normalised 0..1 shading intensity for one solved cell value, against the
 * min/max of the OTHER valid, solved cells in the grid, never against an
 * invalid cell or a no-solution cell, so one outlier or failure cannot flatten
 * the whole scale. Returns 0 when there is no direction to shade toward, or
 * when every solved cell landed on the same value (max === min).
 */
export function shadeIntensity(
  value: number,
  min: number,
  max: number,
  direction: 'higher' | 'lower' | 'none'
): number {
  if (direction === 'none') return 0;
  if (max === min) return 0;
  const t = (value - min) / (max - min);
  return direction === 'higher' ? t : 1 - t;
}

// ---------------------------------------------------------------------------
// Cell state
// ---------------------------------------------------------------------------

export type GridCellState =
  | { status: 'pending' }
  | { status: 'solved'; value: number; pvPct: number }
  | { status: 'invalid'; reason: string }
  | { status: 'no-solution'; reason: string };

export interface GridCell {
  rowIndex: number;
  colIndex: number;
  xValue: number;
  yValue: number;
  state: GridCellState;
}

// ---------------------------------------------------------------------------
// TSV export
// ---------------------------------------------------------------------------

/** Cell text for TSV: the solved value, or a short marker for anything else,
 * so the pasted sheet stays rectangular even when some cells failed. */
function cellText(state: GridCellState): string {
  if (state.status === 'solved') return String(state.value);
  if (state.status === 'invalid') return 'invalid';
  if (state.status === 'no-solution') return 'no solution';
  return '';
}

/**
 * Renders the grid as tab-separated text: a header row of column (X) values,
 * prefixed by a blank corner cell, then one row per Y value with its own
 * label in the first column. Pastes directly into Excel.
 */
export function gridToTsv(xValues: number[], yValues: number[], cells: GridCell[][]): string {
  const header = ['', ...xValues.map(String)].join('\t');
  const rows = yValues.map((y, rowIndex) => {
    const rowCells = cells[rowIndex] ?? [];
    const line = [String(y), ...xValues.map((_, colIndex) => cellText(rowCells[colIndex]?.state ?? { status: 'pending' }))];
    return line.join('\t');
  });
  return [header, ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// Run loop
// ---------------------------------------------------------------------------

interface RunGridParams {
  client: PricerClient;
  baseSpec: ProductSpec;
  market: MarketData;
  xParam: GridParam;
  yParam: GridParam;
  xValues: number[];
  yValues: number[];
  solve: SolveTarget;
  /** Called once per cell as its result lands, so the UI can fill the grid
   * in progressively instead of waiting for the whole run. */
  onCell: (rowIndex: number, colIndex: number, state: GridCellState) => void;
  /** Polled between cells; when it reports aborted, the loop stops issuing
   * further cells. Already-dispatched cells still settle normally. */
  signal?: AbortSignal;
}

function validateSpec(s: ProductSpec, market: MarketData): { valid: boolean; reason: string } {
  if (s.kind === 'coupon') {
    const r = validateCoupon(s, market);
    return { valid: r.valid, reason: Object.values(r.errors)[0] ?? (r.rowErrors ?? []).find((e) => e) ?? 'Invalid terms.' };
  }
  if (s.kind === 'participation') {
    const r = validateParticipation(s, market);
    return { valid: r.valid, reason: Object.values(r.errors)[0] ?? 'Invalid terms.' };
  }
  if (s.kind === 'accumulator') {
    const r = validateAccumulator(s, market);
    return { valid: r.valid, reason: Object.values(r.errors)[0] ?? 'Invalid terms.' };
  }
  // Lab specs never reach the grid (paramRegistry.gridParamsFor('lab') is
  // empty, so the setup row can never select a Lab axis param).
  return { valid: true, reason: '' };
}

/**
 * Runs every cell of the grid, ONE AT A TIME, in row-major order.
 *
 * This is deliberate, not a missed opportunity for concurrency. The MC path
 * cache (src/engine/pathCache.ts) is a SINGLE SLOT per worker, keyed on
 * market data, MC settings and grid shape, but NOT on product terms (see its
 * key, around lines 106-125, and the single-slot store, around lines
 * 150-167). Every cell in this grid shares the same market data and MC
 * settings, differing only in product terms (the two axis fields), so every
 * cell is a hit against the SAME cache slot once it is warm.
 *
 * The pool coordinator (src/worker/realClient.ts:20-52) already spreads the
 * slices of a SINGLE price across every worker in the pool. So one price
 * already uses the whole pool. Firing 25 cells at once would not spread
 * further; it would instead hand each worker a DIFFERENT cell's product
 * terms to evaluate against its currently-cached paths, forcing a cold
 * regenerate per worker per cell, over and over. Running cells sequentially
 * means cell 2 through N reuse the warm cache from cell 1, so a 5x5 grid
 * costs about one cold Monte Carlo pass plus 24 cheap evaluator re-runs,
 * instead of 25 cold passes.
 */
export async function runGrid({
  client,
  baseSpec,
  market,
  xParam,
  yParam,
  xValues,
  yValues,
  solve,
  onCell,
  signal,
}: RunGridParams): Promise<void> {
  let warmStartValue: number | undefined;

  // Lets a Cancel press interrupt the cell currently in flight, not just stop
  // the next one from being dispatched. cancel() is per-id (see
  // pricerClient.cancel), so this never touches any other run.
  let currentId: string | null = null;
  const onAbort = () => {
    if (currentId) client.cancel(currentId);
  };
  signal?.addEventListener('abort', onAbort);

  try {
    for (let rowIndex = 0; rowIndex < yValues.length; rowIndex++) {
      for (let colIndex = 0; colIndex < xValues.length; colIndex++) {
        if (signal?.aborted) return;

        const withX = xParam.write(baseSpec, xValues[colIndex]);
        const withY = yParam.write(withX, yValues[rowIndex]);

        const check = validateSpec(withY, market);
        if (!check.valid) {
          onCell(rowIndex, colIndex, { status: 'invalid', reason: check.reason });
          continue;
        }

        const id = crypto.randomUUID();
        currentId = id;
        const req: PriceRequest = {
          id,
          product: withY,
          market,
          mc: DEFAULT_MC,
          solve,
          greeks: false,
          warmStartValue,
        };

        try {
          const noopProgress = (_p: ProgressUpdate) => {};
          const result = await client.price(req, noopProgress);
          const value = result.solvedValue ?? result.pvPct;
          warmStartValue = solve.kind !== 'none' ? result.solvedValue : warmStartValue;
          onCell(rowIndex, colIndex, { status: 'solved', value, pvPct: result.pvPct });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Pricing failed.';
          // A bracket-has-no-root failure is an expected outcome for some
          // corner of the grid, the exact analogue of the live-reprice
          // liveUnsolvable state in runPricing.ts. Mark just this cell and
          // keep going. Any other error is unexpected, a real fault rather
          // than an unreachable target, so let it propagate and stop the
          // whole run instead of silently filling the rest of the grid with
          // a misleading per-cell message.
          if (NO_SOLUTION_RE.test(message)) {
            onCell(rowIndex, colIndex, { status: 'no-solution', reason: 'No solution at these terms.' });
          } else if (signal?.aborted) {
            // A cancel lands as a rejection from the client too (the real
            // worker client rejects with 'cancelled'). Treat it the same as
            // an aborted loop: stop quietly rather than surfacing an error.
            return;
          } else {
            throw err;
          }
        } finally {
          currentId = null;
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
