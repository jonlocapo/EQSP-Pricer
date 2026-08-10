import { PERIODS_PER_YEAR } from '../../model/product';
import type {
  AutocallBlock,
  BonusBlock,
  CouponBlock,
  ProtectionBlock,
  LabSpec,
  ShortPutBlock,
  UpsideBlock,
} from '../../model/lab';
import type { ObservablesRequirements, PricingGrid } from '../payoffs/types';
import type { Contract, ScheduleEvent } from './contract';
import {
  add,
  alwaysFalse,
  alwaysTrue,
  gte,
  ite,
  konst,
  lt,
  max,
  min,
  or,
  perfAt,
  perfT,
  scale,
  sub,
} from './expr';
import type { Cmp, Expr } from './expr';
import { nearestGridIndex } from './products';

/**
 * Lowers a Contract Lab `LabSpec` (a flat, user-assembled block list — see
 * model/lab.ts) into a `Contract` tree (expr.ts/contract.ts), the same
 * intermediate form products.ts builds by hand for the reverse convertible,
 * booster, and Catapult. Once lowered, the Lab spec inherits
 * compileContract's path-cache and observables-cache fast paths for free —
 * see engine/payoffs/index.ts.
 *
 * Every numeric formula below reuses the EXACT op order products.ts uses
 * for the shape it corresponds to (coupon leg, autocall leg, geared put,
 * participation leg), so a Lab spec assembled to mirror a hand-written
 * product reproduces that product's Contract bit-for-bit. See
 * tests/lab.test.ts for the RC and booster equivalence proofs.
 */

/** Real observation times (years), ascending, for one block's own periodic
 * schedule: k / periodsPerYear for k = 1..round(tenorYears*periodsPerYear).
 * Mirrors engine/schedule.ts's periodicTimes exactly — same numObs
 * rounding, same formula — so a block's own gridIndex set (computed below
 * via nearestGridIndex against the grid actually built) lands on the same
 * indices schedule.ts's buildGrid put in grid.couponObs/callObs for the Lab
 * spec. */
function blockPeriodTimes(tenorYears: number, periodsPerYear: number): number[] {
  const numObs = Math.round(tenorYears * periodsPerYear);
  const times: number[] = [];
  for (let k = 1; k <= numObs; k++) times.push(k / periodsPerYear);
  return times;
}

/** One block's own ascending (time, 1-based own-period, gridIndex) triples,
 * snapped onto `grid` via nearestGridIndex — grid-shape agnostic, so it
 * works whether `grid` ended up compact or daily. */
function blockOwnSchedule(
  frequency: CouponBlock['frequency'],
  tenorYears: number,
  grid: PricingGrid,
): { gridIndex: number; ownPeriod: number }[] {
  const times = blockPeriodTimes(tenorYears, PERIODS_PER_YEAR[frequency]);
  return times.map((t, i) => ({ gridIndex: nearestGridIndex(t, grid), ownPeriod: i + 1 }));
}

/** knock-in condition for one shortPut block. Identical construction to
 * products.ts's RC/booster/Catapult kiCond: 'none' is always live,
 * 'european' compares terminal perf, 'american' compares the running
 * minimum. */
function kiCondFor(block: ShortPutBlock): Cmp {
  if (block.barrierType === 'none') return alwaysTrue();
  const level = konst(block.kiBarrierPct / 100);
  return block.barrierType === 'european' ? lt(perfT(), level) : lt({ t: 'minPerf' }, level);
}

/** Autocall barrier, decimal, for 1-based own-period j. Same stepdown
 * formula as products.ts's callBarrierDecimal('stepdown' case) —
 * `stepDownPct: 0` reduces to a flat barrier through a harmless `-0`. */
function autocallBarrierDecimal(block: AutocallBlock, j: number): number {
  return (block.barrierPct - block.stepDownPct * (j - block.fromPeriod)) / 100;
}

/** Autocall redemption at own-period j: always snowball-shaped, matching
 * products.ts's redemptionCostPctAt('snowball' case). `snowballPaPct: 0`
 * reduces to a flat 100 exactly (100 + 0*j/pp = 100.0). */
function autocallRedemptionPct(block: AutocallBlock, j: number): number {
  return 100 + (block.snowballPaPct * j) / PERIODS_PER_YEAR[block.frequency];
}

function couponAmountPct(block: CouponBlock): number {
  return block.ratePaPct / PERIODS_PER_YEAR[block.frequency];
}

/** Merged event carries every coupon/autocall block hitting this gridIndex,
 * plus each block's own 1-based period at this date (needed for a snowball
 * autocall's j-dependent redemption, and for period-gating an autocall's
 * fromPeriod). */
interface MergedEvent {
  gridIndex: number;
  coupons: { block: CouponBlock; ownPeriod: number }[];
  autocalls: { block: AutocallBlock; ownPeriod: number }[];
}

function mergeLabEvents(spec: LabSpec, grid: PricingGrid): MergedEvent[] {
  const byIndex = new Map<number, MergedEvent>();
  const get = (gridIndex: number): MergedEvent => {
    let ev = byIndex.get(gridIndex);
    if (!ev) {
      ev = { gridIndex, coupons: [], autocalls: [] };
      byIndex.set(gridIndex, ev);
    }
    return ev;
  };

  for (const block of spec.blocks) {
    if (block.t === 'coupon') {
      for (const { gridIndex, ownPeriod } of blockOwnSchedule(block.frequency, spec.tenorYears, grid)) {
        get(gridIndex).coupons.push({ block, ownPeriod });
      }
    } else if (block.t === 'autocall') {
      for (const { gridIndex, ownPeriod } of blockOwnSchedule(block.frequency, spec.tenorYears, grid)) {
        if (ownPeriod < block.fromPeriod) continue;
        get(gridIndex).autocalls.push({ block, ownPeriod });
      }
    }
  }

  return Array.from(byIndex.values()).sort((a, b) => a.gridIndex - b.gridIndex);
}

/** Coupon leg for one merged event, given every coupon block that observes
 * there. A single block reproduces products.ts's exact two formulas
 * (unconditional const, or barrier-gated conditional/memory). More than one
 * block at the same date combines by OR-of-conditions (pay/accrue check)
 * and a summed, individually-gated amount — see the module doc for why a
 * single shared `missed` counter is the ceiling of what the compiler can
 * express for several coupon streams landing on one date. */
function couponLegFor(
  coupons: { block: CouponBlock; ownPeriod: number }[],
  obsIndex: number,
): { condition: Cmp; amount: Expr; memory: boolean } {
  const perf = perfAt(obsIndex);
  if (coupons.length === 1) {
    const { block } = coupons[0];
    const amt = konst(couponAmountPct(block));
    if (block.barrierPct === null) return { condition: alwaysTrue(), amount: amt, memory: false };
    return { condition: gte(perf, konst(block.barrierPct / 100)), amount: amt, memory: block.memory };
  }

  let condition: Cmp = alwaysFalse();
  let amount: Expr = konst(0);
  let memory = false;
  for (const { block } of coupons) {
    const amt = konst(couponAmountPct(block));
    if (block.barrierPct === null) {
      condition = alwaysTrue();
      amount = add(amount, amt);
    } else {
      const cond = gte(perf, konst(block.barrierPct / 100));
      condition = or(condition, cond);
      amount = add(amount, ite(cond, amt, konst(0)));
    }
    memory = memory || block.memory;
  }
  return { condition, amount, memory };
}

/** Autocall leg for one merged event, given every autocall block observing
 * there (already period-gated: ownPeriod >= block.fromPeriod). A single
 * block matches products.ts's isCallable/autocall construction exactly.
 * Several blocks combine as an ordered ite-chain, so the FIRST block (in
 * blocks[] order) that is triggered decides the redemption — the condition
 * reported is the OR of all of them, so the compiler autocalls if any
 * fires. */
function autocallLegFor(
  autocalls: { block: AutocallBlock; ownPeriod: number }[],
  obsIndex: number,
): { condition: Cmp; redemption: Expr } {
  const perf = perfAt(obsIndex);
  if (autocalls.length === 1) {
    const { block, ownPeriod } = autocalls[0];
    return {
      condition: gte(perf, konst(autocallBarrierDecimal(block, ownPeriod))),
      redemption: konst(autocallRedemptionPct(block, ownPeriod)),
    };
  }

  let condition: Cmp = alwaysFalse();
  let redemption: Expr = konst(autocallRedemptionPct(autocalls[autocalls.length - 1].block, autocalls[autocalls.length - 1].ownPeriod));
  for (let i = autocalls.length - 1; i >= 0; i--) {
    const { block, ownPeriod } = autocalls[i];
    const cond = gte(perf, konst(autocallBarrierDecimal(block, ownPeriod)));
    condition = or(condition, cond);
    redemption = ite(cond, konst(autocallRedemptionPct(block, ownPeriod)), redemption);
  }
  return { condition, redemption };
}

/** Validates a Lab spec, throwing a clear message on nonsense terms. Two
 * protection blocks with different floors is fine — the contract builder
 * takes the max. A negative frequency has no such fallback: `Frequency` is
 * a closed enum, so a bad frequency can only arrive as a bug upstream, and
 * a coupon/autocall block with a non-positive rate, period, or barrier is
 * what actually needs rejecting here. */
export function validateLabSpec(spec: LabSpec): void {
  if (spec.tenorYears <= 0) throw new Error('Lab: tenorYears must be positive.');
  if (spec.blocks.length === 0) throw new Error('Lab: add at least one block.');

  for (const block of spec.blocks) {
    switch (block.t) {
      case 'coupon':
        if (block.ratePaPct < 0) throw new Error('Lab: coupon rate cannot be negative.');
        if (block.barrierPct !== null && block.barrierPct < 0) {
          throw new Error('Lab: coupon barrier cannot be negative.');
        }
        break;
      case 'autocall':
        if (block.fromPeriod < 1) throw new Error('Lab: autocall fromPeriod must be >= 1.');
        if (block.barrierPct <= 0) throw new Error('Lab: autocall barrier must be positive.');
        break;
      case 'shortPut':
        if (block.strikePct <= 0) throw new Error('Lab: shortPut strike must be positive.');
        if (block.leveragePct < 0) throw new Error('Lab: shortPut leverage cannot be negative.');
        if (block.barrierType !== 'none' && block.kiBarrierPct <= 0) {
          throw new Error('Lab: shortPut KI barrier must be positive.');
        }
        break;
      case 'upside':
        if (block.strikePct <= 0) throw new Error('Lab: upside strike must be positive.');
        if (block.participationPct < 0) throw new Error('Lab: upside participation cannot be negative.');
        if (block.capPct !== null && block.capPct < 0) throw new Error('Lab: upside cap cannot be negative.');
        break;
      case 'bonus':
        if (block.barrierPct !== null && block.barrierPct < 0) {
          throw new Error('Lab: bonus barrier cannot be negative.');
        }
        break;
      case 'protection':
        if (block.floorPct < 0) throw new Error('Lab: protection floor cannot be negative.');
        break;
    }
  }
}

/**
 * Observables requirements descriptor for a Lab spec: which of
 * minPerf/maxPerf the pathCache's observables sub-cache needs to key on
 * (see pathCache.ts's computeObservablesKey / ObservablesRequirements'
 * doc). Depends ONLY on monitoring MODE and the schedule shape, never on
 * barrier LEVELS. So two Lab specs that differ only in a barrier level
 * report the identical descriptor, and a barrier-level solve keeps hitting
 * the observables cache — this is the property the whole split-evaluator
 * design exists for. `needsMin` is true whenever any shortPut block
 * monitors 'american' (running minimum). No Lab block currently reads a
 * running maximum — that would be a koRebate-style upside block, which the
 * Lab palette does not offer yet — so `needsMax` is always false today,
 * kept as an explicit field so a future block type can flip it without
 * reshaping this descriptor.
 */
export function labObservablesRequirements(spec: LabSpec): ObservablesRequirements {
  return {
    needsMin: spec.blocks.some((b) => b.t === 'shortPut' && b.barrierType === 'american'),
    needsMax: false,
  };
}

/**
 * The grid indices the compiled contract will index `eventPerf` by. This is
 * `mergeLabEvents`' own list, which is NOT the grid's `callObs`: an autocall
 * block drops every observation before its `fromPeriod`, and the grid's
 * observation union does not. The observables cache key reads this so a
 * `fromPeriod` edit moves the key. See `observablesEventIndicesOf`.
 */
export function labEventGridIndices(spec: LabSpec, grid: PricingGrid): number[] {
  return mergeLabEvents(spec, grid).map((e) => e.gridIndex);
}

export function buildLabContract(spec: LabSpec, grid: PricingGrid): Contract {
  validateLabSpec(spec);

  const merged = mergeLabEvents(spec, grid);
  const events: ScheduleEvent[] = merged.map((me, obsIndex) => {
    const event: ScheduleEvent = { gridIndex: me.gridIndex, period: 0 };
    if (me.coupons.length > 0) {
      event.period = me.coupons[0].ownPeriod;
      event.coupon = couponLegFor(me.coupons, obsIndex);
    }
    if (me.autocalls.length > 0) {
      event.period = me.autocalls[0].ownPeriod;
      const { condition, redemption } = autocallLegFor(me.autocalls, obsIndex);
      event.autocall = { condition, redemption };
    }
    return event;
  });

  const perfTNode = perfT();
  const shortPutBlocks = spec.blocks.filter((b): b is ShortPutBlock => b.t === 'shortPut');
  const upsideBlocks = spec.blocks.filter((b): b is UpsideBlock => b.t === 'upside');
  const bonusBlocks = spec.blocks.filter((b): b is BonusBlock => b.t === 'bonus');
  const protectionBlocks = spec.blocks.filter((b): b is ProtectionBlock => b.t === 'protection');

  // Maturity payoff: par, plus every upside leg, minus every shortPut leg's
  // KI-gated loss, plus every bonus leg, floored last by the highest
  // protection block (default floor 0 — see the module doc's derivation of
  // why this reduces exactly to the RC/booster formulas for the common
  // single-block case).
  let base: Expr = konst(100);

  for (const u of upsideBlocks) {
    // Same double-scale op order as products.ts's upsideRaw, so a Lab
    // upside leg is bit-identical to a hand-written participation leg for
    // the same terms.
    let leg = scale(scale(max(konst(0), sub(perfTNode, konst(u.strikePct / 100))), u.participationPct / 100), 100);
    if (u.capPct !== null) leg = min(leg, konst(u.capPct));
    base = add(base, leg);
  }

  for (const p of shortPutBlocks) {
    const shortfall = max(konst(0), sub(konst(p.strikePct), scale(perfTNode, 100)));
    const loss = scale(shortfall, p.leveragePct / 100);
    base = sub(base, ite(kiCondFor(p), loss, konst(0)));
  }

  for (const bonus of bonusBlocks) {
    const amt = konst(bonus.bonusPct);
    const leg = bonus.barrierPct === null ? amt : ite(gte(perfTNode, konst(bonus.barrierPct / 100)), amt, konst(0));
    base = add(base, leg);
  }

  const floorPct = protectionBlocks.length > 0 ? Math.max(...protectionBlocks.map((b) => b.floorPct)) : 0;
  const maturity: Expr = max(base, konst(floorPct));

  const kiConds = shortPutBlocks.filter((b) => b.barrierType !== 'none').map(kiCondFor);
  const kiEvent = kiConds.length > 0 ? kiConds.reduce((a, b) => or(a, b)) : undefined;

  // Report koEvent whenever any autocall block exists, matching the
  // reporting convention products.ts's Catapult would use if it exposed
  // one. This is the OR of every merged event's own autocall condition —
  // by construction it can only ever read false where it is actually
  // evaluated (the maturity leg, reached only on a path where none of
  // those conditions fired along the way), but the field's presence itself
  // is what "an autocall block exists" is reporting.
  const hasAutocallBlocks = spec.blocks.some((b) => b.t === 'autocall');
  const koEvent = hasAutocallBlocks
    ? events
        .filter((e) => e.autocall)
        .map((e) => e.autocall!.condition)
        .reduce((a: Cmp | undefined, c) => (a ? or(a, c) : c), undefined)
    : undefined;

  return {
    events,
    maturity,
    maturityGridIndex: grid.nSteps,
    maturityLifeYears: spec.tenorYears,
    reporting: { kiEvent, koEvent },
  };
}
