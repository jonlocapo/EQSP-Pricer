/**
 * Contract Lab block spec: a flat, JSON-serializable list of building
 * blocks the user assembles in the UI. The UI never builds an `Expr` tree
 * directly (see engine/combinators/expr.ts). It builds this list. The
 * worker turns the list into a `Contract` (see engine/combinators/lab.ts).
 * A flat, structured-cloneable spec crosses the worker boundary safely, and
 * it keeps grid-dependent index maths — which needs a `PricingGrid` — on
 * the engine side, where it belongs.
 */
import type { BarrierMonitoring, CommonTerms, Frequency } from './product';

/** Periodic coupon leg. `barrierPct: null` means the coupon is
 * unconditional (paid every observation, like a fixed coupon). A set
 * `barrierPct` gates the coupon on perf at or above that level. `memory`
 * mirrors phoenix semantics: a missed coupon accrues and pays on the next
 * hit. */
export interface CouponBlock {
  t: 'coupon';
  id: string;
  frequency: Frequency;
  ratePaPct: number;
  barrierPct: number | null;
  memory: boolean;
}

/** Autocall (call) leg. The note redeems early at `100 + snowball accrual`
 * the first time perf, at this block's own observation frequency and from
 * `fromPeriod` onward, is at or above `barrierPct`. `stepDownPct` reduces
 * the barrier by that amount per observation after the first callable one;
 * 0 gives a flat barrier. */
export interface AutocallBlock {
  t: 'autocall';
  id: string;
  frequency: Frequency;
  fromPeriod: number;
  barrierPct: number;
  stepDownPct: number;
  snowballPaPct: number;
}

/** Short put leg: a geared loss on terminal performance below `strikePct`,
 * live only once knocked in per `barrierType`/`kiBarrierPct`. `barrierType:
 * 'none'` means the put is always live, no knock-in gate at all. */
export interface ShortPutBlock {
  t: 'shortPut';
  id: string;
  strikePct: number;
  leveragePct: number;
  barrierType: BarrierMonitoring;
  kiBarrierPct: number;
}

/** Upside participation leg above `strikePct`. `capPct: null` means
 * uncapped; a set value caps the leg's own payout at that level. */
export interface UpsideBlock {
  t: 'upside';
  id: string;
  strikePct: number;
  participationPct: number;
  capPct: number | null;
}

/** Flat bonus amount above par. `barrierPct: null` pays unconditionally; a
 * set value gates the bonus on terminal perf at or above that level. */
export interface BonusBlock {
  t: 'bonus';
  id: string;
  bonusPct: number;
  barrierPct: number | null;
}

/** Capital protection floor: the maturity redemption never pays below
 * `floorPct` of notional. Two protection blocks are not a conflict — the
 * higher floor wins. */
export interface ProtectionBlock {
  t: 'protection';
  id: string;
  floorPct: number;
}

export type LabBlock =
  | CouponBlock
  | AutocallBlock
  | ShortPutBlock
  | UpsideBlock
  | BonusBlock
  | ProtectionBlock;

export interface LabSpec extends CommonTerms {
  kind: 'lab';
  blocks: LabBlock[];
}

let seq = 0;
/** Deterministic-enough id for a freshly added block: readable, unique
 * within one session. Not a UUID — the Lab spec is a UI/session artifact,
 * never persisted or compared across sessions. */
function nextId(t: LabBlock['t']): string {
  seq += 1;
  return `${t}-${seq}`;
}

export function makeBlock(t: LabBlock['t']): LabBlock {
  switch (t) {
    case 'coupon':
      return { t, id: nextId(t), frequency: 'quarterly', ratePaPct: 8, barrierPct: 60, memory: true };
    case 'autocall':
      return { t, id: nextId(t), frequency: 'quarterly', fromPeriod: 1, barrierPct: 100, stepDownPct: 0, snowballPaPct: 0 };
    case 'shortPut':
      return { t, id: nextId(t), strikePct: 100, leveragePct: 100, barrierType: 'european', kiBarrierPct: 60 };
    case 'upside':
      return { t, id: nextId(t), strikePct: 100, participationPct: 100, capPct: null };
    case 'bonus':
      return { t, id: nextId(t), bonusPct: 10, barrierPct: null };
    case 'protection':
      return { t, id: nextId(t), floorPct: 90 };
  }
}

const commonDefaults: CommonTerms = {
  underlyings: [{ name: 'SPX' }],
  currency: 'USD',
  notional: 1_000_000,
  tenorYears: 2,
  reofferPct: 98.5,
  issuePricePct: 100,
};

/** Named starting points for the Lab canvas, so the feature does not open
 * on a blank list. Each preset is a plain LabSpec, built from the same
 * block types the palette offers — no hidden shapes. */
export const LAB_PRESETS: { name: string; build: () => LabSpec }[] = [
  {
    name: 'Reverse convertible',
    build: () => ({
      kind: 'lab',
      ...commonDefaults,
      blocks: [
        { t: 'coupon', id: nextId('coupon'), frequency: 'quarterly', ratePaPct: 8, barrierPct: 60, memory: false },
        { t: 'shortPut', id: nextId('shortPut'), strikePct: 100, leveragePct: 100, barrierType: 'european', kiBarrierPct: 60 },
      ],
    }),
  },
  {
    name: 'Phoenix autocall',
    build: () => ({
      kind: 'lab',
      ...commonDefaults,
      blocks: [
        { t: 'coupon', id: nextId('coupon'), frequency: 'quarterly', ratePaPct: 8, barrierPct: 60, memory: true },
        { t: 'autocall', id: nextId('autocall'), frequency: 'quarterly', fromPeriod: 1, barrierPct: 100, stepDownPct: 0, snowballPaPct: 0 },
        { t: 'shortPut', id: nextId('shortPut'), strikePct: 100, leveragePct: 100, barrierType: 'european', kiBarrierPct: 60 },
      ],
    }),
  },
  {
    name: 'Booster',
    build: () => ({
      kind: 'lab',
      ...commonDefaults,
      blocks: [
        { t: 'upside', id: nextId('upside'), strikePct: 100, participationPct: 150, capPct: null },
        { t: 'shortPut', id: nextId('shortPut'), strikePct: 100, leveragePct: 100, barrierType: 'none', kiBarrierPct: 60 },
      ],
    }),
  },
  {
    name: 'Catapult',
    build: () => ({
      kind: 'lab',
      ...commonDefaults,
      blocks: [
        { t: 'autocall', id: nextId('autocall'), frequency: 'quarterly', fromPeriod: 4, barrierPct: 100, stepDownPct: 0, snowballPaPct: 8 },
        { t: 'upside', id: nextId('upside'), strikePct: 100, participationPct: 150, capPct: null },
        { t: 'shortPut', id: nextId('shortPut'), strikePct: 100, leveragePct: 100, barrierType: 'european', kiBarrierPct: 60 },
        { t: 'protection', id: nextId('protection'), floorPct: 90 },
      ],
    }),
  },
];
