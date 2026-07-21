import type { EvaluatorContext, OutcomeEvaluator, PathObservables, SplitEvaluator } from '../payoffs/types';
import { timeOf } from '../payoffs/types';
import type { Contract } from './contract';
import type { Cmp, Expr } from './expr';
import { makeContractObservables } from './observables';

/**
 * Lowers a `Contract` tree (expr.ts + contract.ts) into a `SplitEvaluator` —
 * the exact interface makeSplitEvaluator/pathCache.ts already know how to
 * cache and replay (see payoffs/index.ts, engine/pathCache.ts). This is the
 * whole point of the combinator layer: any tree built from the primitive
 * algebra automatically inherits the observables/path-cache fast path,
 * with no special-casing needed anywhere else in the engine.
 *
 * Three techniques, in order of appearance below:
 *
 * 1. Hash-consing: `Expr`/`Cmp` are plain (possibly duplicated) object
 *    trees authored by product builders (products.ts). `intern` folds
 *    structurally-identical subtrees into one row of a flat `CNode[]`
 *    table, keyed by a canonical string signature over already-interned
 *    child indices (so it hash-conses bottom-up, one array-index compare
 *    per level, not full tree diffing).
 * 2. Path-independent hoisting: any node whose entire subtree is made of
 *    `const`/boolean-literal leaves (no perfT/minPerf/maxPerf/perfAt) is
 *    constant-folded to a number *once*, at compile time — `isConst`/
 *    `constVal` on the CNode row. Discount factors are hoisted the same
 *    way: each schedule event's df(t) and the maturity df(T) are computed
 *    once in `compileContract`, before any path is evaluated, since event
 *    times never depend on the path.
 * 3. Per-path memo: each DAG node gets a stable integer index. A single
 *    `Float64Array` (values) + `Int32Array` (generation stamps) pair is
 *    preallocated once per compiled contract and reused across every path.
 *    Each path bumps a `gen` counter; a node is "already computed this
 *    path" iff `stamp[idx] === gen` — no per-path zeroing, no Map, no
 *    allocation in the hot loop.
 */

type NodeKind =
  | 'const'
  | 'perfT'
  | 'minPerf'
  | 'maxPerf'
  | 'perfAt'
  | 'add'
  | 'sub'
  | 'scale'
  | 'max'
  | 'min'
  | 'ite'
  | 'ind'
  | 'true'
  | 'false'
  | 'gte'
  | 'gt'
  | 'lt'
  | 'lte'
  | 'and'
  | 'or'
  | 'not';

/** One hash-consed DAG row. Unused child slots are -1. `num` doubles as the
 * const value (kind 'const') or the scale factor (kind 'scale'); `obsIndex`
 * is only meaningful for 'perfAt'. `a`/`b`/`c` are child node indices;
 * 'ite' uses a=cond, b=trueBranch, c=falseBranch; 'ind'/'not' use a=cond. */
interface CNode {
  kind: NodeKind;
  a: number;
  b: number;
  c: number;
  num: number;
  obsIndex: number;
  isConst: boolean;
  constVal: number;
}

class Interner {
  readonly nodes: CNode[] = [];
  private readonly byKey = new Map<string, number>();

  private push(kind: NodeKind, a: number, b: number, c: number, num: number, obsIndex: number): number {
    const key = `${kind}:${a}:${b}:${c}:${num}:${obsIndex}`;
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;

    const idx = this.nodes.length;
    const isConst = computeIsConst(kind, a, b, c, this.nodes);
    const constVal = isConst ? computeConstVal(kind, a, b, c, num, this.nodes) : NaN;
    this.nodes.push({ kind, a, b, c, num, obsIndex, isConst, constVal });
    this.byKey.set(key, idx);
    return idx;
  }

  internExpr(e: Expr): number {
    switch (e.t) {
      case 'const':
        return this.push('const', -1, -1, -1, e.v, -1);
      case 'perfT':
        return this.push('perfT', -1, -1, -1, 0, -1);
      case 'minPerf':
        return this.push('minPerf', -1, -1, -1, 0, -1);
      case 'maxPerf':
        return this.push('maxPerf', -1, -1, -1, 0, -1);
      case 'perfAt':
        return this.push('perfAt', -1, -1, -1, 0, e.i);
      case 'add':
        return this.push('add', this.internExpr(e.a), this.internExpr(e.b), -1, 0, -1);
      case 'sub':
        return this.push('sub', this.internExpr(e.a), this.internExpr(e.b), -1, 0, -1);
      case 'scale':
        return this.push('scale', this.internExpr(e.a), -1, -1, e.k, -1);
      case 'max':
        return this.push('max', this.internExpr(e.a), this.internExpr(e.b), -1, 0, -1);
      case 'min':
        return this.push('min', this.internExpr(e.a), this.internExpr(e.b), -1, 0, -1);
      case 'ite':
        return this.push('ite', this.internCmp(e.cond), this.internExpr(e.a), this.internExpr(e.b), 0, -1);
      case 'ind':
        return this.push('ind', this.internCmp(e.cond), -1, -1, 0, -1);
    }
  }

  internCmp(c: Cmp): number {
    switch (c.t) {
      case 'true':
        return this.push('true', -1, -1, -1, 0, -1);
      case 'false':
        return this.push('false', -1, -1, -1, 0, -1);
      case 'gte':
        return this.push('gte', this.internExpr(c.a), this.internExpr(c.b), -1, 0, -1);
      case 'gt':
        return this.push('gt', this.internExpr(c.a), this.internExpr(c.b), -1, 0, -1);
      case 'lt':
        return this.push('lt', this.internExpr(c.a), this.internExpr(c.b), -1, 0, -1);
      case 'lte':
        return this.push('lte', this.internExpr(c.a), this.internExpr(c.b), -1, 0, -1);
      case 'and':
        return this.push('and', this.internCmp(c.a), this.internCmp(c.b), -1, 0, -1);
      case 'or':
        return this.push('or', this.internCmp(c.a), this.internCmp(c.b), -1, 0, -1);
      case 'not':
        return this.push('not', this.internCmp(c.a), -1, -1, 0, -1);
    }
  }
}

/** Path-dependent leaves (perfT/minPerf/maxPerf/perfAt) are never const;
 * every other node is const iff all of its children are (children are
 * already-interned indices, so this is a plain array lookup — no
 * recursion). 'ite' is conservatively const only when cond AND both
 * branches are const (sufficient, not necessary, but always safe). */
function computeIsConst(kind: NodeKind, a: number, b: number, c: number, nodes: CNode[]): boolean {
  switch (kind) {
    case 'const':
    case 'true':
    case 'false':
      return true;
    case 'perfT':
    case 'minPerf':
    case 'maxPerf':
    case 'perfAt':
      return false;
    case 'not':
    case 'scale':
    case 'ind':
      return nodes[a].isConst;
    case 'ite':
      return nodes[a].isConst && nodes[b].isConst && nodes[c].isConst;
    default:
      return nodes[a].isConst && nodes[b].isConst;
  }
}

function computeConstVal(kind: NodeKind, a: number, b: number, c: number, num: number, nodes: CNode[]): number {
  const av = a >= 0 ? nodes[a].constVal : NaN;
  const bv = b >= 0 ? nodes[b].constVal : NaN;
  switch (kind) {
    case 'const':
      return num;
    case 'true':
      return 1;
    case 'false':
      return 0;
    case 'add':
      return av + bv;
    case 'sub':
      return av - bv;
    case 'scale':
      return av * num;
    case 'max':
      return Math.max(av, bv);
    case 'min':
      return Math.min(av, bv);
    case 'gte':
      return av >= bv ? 1 : 0;
    case 'gt':
      return av > bv ? 1 : 0;
    case 'lt':
      return av < bv ? 1 : 0;
    case 'lte':
      return av <= bv ? 1 : 0;
    case 'and':
      return av !== 0 && bv !== 0 ? 1 : 0;
    case 'or':
      return av !== 0 || bv !== 0 ? 1 : 0;
    case 'not':
      return av !== 0 ? 0 : 1;
    case 'ind':
      return av;
    case 'ite':
      return (av !== 0 ? nodes[b].constVal : nodes[c].constVal);
    default:
      // perfT/minPerf/maxPerf/perfAt never reach here (isConst is false).
      return NaN;
  }
}

/** Per-path memoized DAG evaluation. Constant nodes short-circuit without
 * touching memo/stamp at all (they were folded once at compile time);
 * everything else is computed at most once per path per unique node,
 * keyed by the generation stamp. */
function evalNode(
  idx: number,
  nodes: CNode[],
  memo: Float64Array,
  stamp: Int32Array,
  gen: number,
  obs: PathObservables,
): number {
  const n = nodes[idx];
  if (n.isConst) return n.constVal;
  if (stamp[idx] === gen) return memo[idx];

  let v: number;
  switch (n.kind) {
    case 'perfT':
      v = obs.perfT;
      break;
    case 'minPerf':
      v = obs.minPerf;
      break;
    case 'maxPerf':
      v = obs.maxPerf;
      break;
    case 'perfAt':
      v = obs.eventPerf[n.obsIndex];
      break;
    case 'add':
      v = evalNode(n.a, nodes, memo, stamp, gen, obs) + evalNode(n.b, nodes, memo, stamp, gen, obs);
      break;
    case 'sub':
      v = evalNode(n.a, nodes, memo, stamp, gen, obs) - evalNode(n.b, nodes, memo, stamp, gen, obs);
      break;
    case 'scale':
      v = evalNode(n.a, nodes, memo, stamp, gen, obs) * n.num;
      break;
    case 'max':
      v = Math.max(evalNode(n.a, nodes, memo, stamp, gen, obs), evalNode(n.b, nodes, memo, stamp, gen, obs));
      break;
    case 'min':
      v = Math.min(evalNode(n.a, nodes, memo, stamp, gen, obs), evalNode(n.b, nodes, memo, stamp, gen, obs));
      break;
    case 'ite':
      v =
        evalNode(n.a, nodes, memo, stamp, gen, obs) !== 0
          ? evalNode(n.b, nodes, memo, stamp, gen, obs)
          : evalNode(n.c, nodes, memo, stamp, gen, obs);
      break;
    case 'ind':
      v = evalNode(n.a, nodes, memo, stamp, gen, obs);
      break;
    case 'gte':
      v = evalNode(n.a, nodes, memo, stamp, gen, obs) >= evalNode(n.b, nodes, memo, stamp, gen, obs) ? 1 : 0;
      break;
    case 'gt':
      v = evalNode(n.a, nodes, memo, stamp, gen, obs) > evalNode(n.b, nodes, memo, stamp, gen, obs) ? 1 : 0;
      break;
    case 'lt':
      v = evalNode(n.a, nodes, memo, stamp, gen, obs) < evalNode(n.b, nodes, memo, stamp, gen, obs) ? 1 : 0;
      break;
    case 'lte':
      v = evalNode(n.a, nodes, memo, stamp, gen, obs) <= evalNode(n.b, nodes, memo, stamp, gen, obs) ? 1 : 0;
      break;
    case 'and':
      v =
        evalNode(n.a, nodes, memo, stamp, gen, obs) !== 0 && evalNode(n.b, nodes, memo, stamp, gen, obs) !== 0
          ? 1
          : 0;
      break;
    case 'or':
      v =
        evalNode(n.a, nodes, memo, stamp, gen, obs) !== 0 || evalNode(n.b, nodes, memo, stamp, gen, obs) !== 0
          ? 1
          : 0;
      break;
    case 'not':
      v = evalNode(n.a, nodes, memo, stamp, gen, obs) !== 0 ? 0 : 1;
      break;
    case 'true':
      v = 1;
      break;
    case 'false':
      v = 0;
      break;
    default:
      v = 0;
  }

  memo[idx] = v;
  stamp[idx] = gen;
  return v;
}

interface CompiledEvent {
  gridIndex: number;
  period: number;
  /** Discount factor at this event's time — path-independent, computed
   * once here rather than per path. */
  df: number;
  coupon?: { condIdx: number; amtIdx: number; memory: boolean };
  autocall?: { condIdx: number; redIdx: number };
}

/** Compiles a `Contract` tree into a `SplitEvaluator`. Plugs into
 * makeSplitEvaluator/pathCache.ts unchanged: `observables` only depends on
 * the contract's schedule shape (never on Expr/Cmp numeric leaves), and
 * `outcome` is a pure function of `PathObservables` — exactly the phase
 * split the rest of the engine already knows how to cache. */
export function compileContract(contract: Contract, ctx: EvaluatorContext): SplitEvaluator {
  const { grid } = ctx;
  const interner = new Interner();

  const compiledEvents: CompiledEvent[] = contract.events.map((ev) => ({
    gridIndex: ev.gridIndex,
    period: ev.period,
    df: ctx.df(timeOf(ev.gridIndex, grid)),
    coupon: ev.coupon
      ? {
          condIdx: interner.internCmp(ev.coupon.condition),
          amtIdx: interner.internExpr(ev.coupon.amount),
          memory: ev.coupon.memory,
        }
      : undefined,
    autocall: ev.autocall
      ? { condIdx: interner.internCmp(ev.autocall.condition), redIdx: interner.internExpr(ev.autocall.redemption) }
      : undefined,
  }));

  const maturityIdx = interner.internExpr(contract.maturity);
  const dfMaturity = ctx.df(timeOf(contract.maturityGridIndex, grid));
  const kiIdx = contract.reporting?.kiEvent ? interner.internCmp(contract.reporting.kiEvent) : undefined;
  const koIdx = contract.reporting?.koEvent ? interner.internCmp(contract.reporting.koEvent) : undefined;
  const upsideKoIdx = contract.reporting?.upsideKoEvent
    ? interner.internCmp(contract.reporting.upsideKoEvent)
    : undefined;

  const nodes = interner.nodes;
  // Per-path memo, preallocated once and reused across every path this
  // compiled contract ever evaluates — zero allocation in the hot loop.
  const memo = new Float64Array(nodes.length);
  const stamp = new Int32Array(nodes.length);
  let gen = 0;

  const eventGridIndices = compiledEvents.map((e) => e.gridIndex);
  const observables = makeContractObservables(eventGridIndices);

  const outcome: OutcomeEvaluator = (obs: PathObservables) => {
    gen++;
    const ev1 = (idx: number) => evalNode(idx, nodes, memo, stamp, gen, obs);

    let pvPct = 0;
    let missed = 0;

    for (const ev of compiledEvents) {
      if (ev.coupon) {
        const cond = ev1(ev.coupon.condIdx) !== 0;
        if (ev.coupon.memory) {
          if (cond) {
            pvPct += ev.df * ev1(ev.coupon.amtIdx) * (1 + missed);
            missed = 0;
          } else {
            missed++;
          }
        } else if (cond) {
          pvPct += ev.df * ev1(ev.coupon.amtIdx);
        }
      }

      if (ev.autocall) {
        const cond = ev1(ev.autocall.condIdx) !== 0;
        if (cond) {
          pvPct += ev.df * ev1(ev.autocall.redIdx);
          return {
            pvPct,
            calledAtPeriod: ev.period,
            kiEvent: undefined,
            lifeYears: timeOf(ev.gridIndex, grid),
          };
        }
      }
    }

    pvPct += dfMaturity * ev1(maturityIdx);

    return {
      pvPct,
      kiEvent: kiIdx !== undefined ? ev1(kiIdx) !== 0 : undefined,
      upsideKoEvent: upsideKoIdx !== undefined ? ev1(upsideKoIdx) !== 0 : undefined,
      koEvent: koIdx !== undefined ? ev1(koIdx) !== 0 : undefined,
      lifeYears: contract.maturityLifeYears,
    };
  };

  return { observables, outcome };
}
