/**
 * Primitive scalar-expression algebra for the contract-combinator DSL.
 *
 * `Expr` nodes evaluate to a number given a path's `PathObservables` (see
 * ../payoffs/types.ts): terminal/running performance leaves, arithmetic
 * combinators, and a boolean sub-language (`Cmp`) used for indicators and
 * if/then/else branching. Discounting is deliberately NOT part of this
 * algebra — it lives in the outcome/aggregation layer (compile.ts), applied
 * once per schedule event using a discount factor computed at compile time
 * (event times are path-independent).
 *
 * These are plain, immutable data objects (no builder/interning state) so a
 * product's tree can be assembled with ordinary function composition. The
 * compiler (compile.ts) hash-conses this tree into a DAG at compile time.
 */

export type Expr =
  | { t: 'const'; v: number }
  | { t: 'perfT' }
  | { t: 'minPerf' }
  | { t: 'maxPerf' }
  /** Performance at the obsIndex-th slot of the contract's merged
   * observation schedule (obs.eventPerf[obsIndex]). */
  | { t: 'perfAt'; i: number }
  | { t: 'add'; a: Expr; b: Expr }
  | { t: 'sub'; a: Expr; b: Expr }
  | { t: 'scale'; a: Expr; k: number }
  | { t: 'max'; a: Expr; b: Expr }
  | { t: 'min'; a: Expr; b: Expr }
  | { t: 'ite'; cond: Cmp; a: Expr; b: Expr }
  /** Numeric 0/1 view of a boolean condition. */
  | { t: 'ind'; cond: Cmp };

export type Cmp =
  | { t: 'true' }
  | { t: 'false' }
  | { t: 'gte'; a: Expr; b: Expr }
  | { t: 'gt'; a: Expr; b: Expr }
  | { t: 'lt'; a: Expr; b: Expr }
  | { t: 'lte'; a: Expr; b: Expr }
  | { t: 'and'; a: Cmp; b: Cmp }
  | { t: 'or'; a: Cmp; b: Cmp }
  | { t: 'not'; a: Cmp };

// --- Expr builders ---------------------------------------------------------

export const konst = (v: number): Expr => ({ t: 'const', v });
export const perfT = (): Expr => ({ t: 'perfT' });
export const minPerf = (): Expr => ({ t: 'minPerf' });
export const maxPerf = (): Expr => ({ t: 'maxPerf' });
export const perfAt = (i: number): Expr => ({ t: 'perfAt', i });
export const add = (a: Expr, b: Expr): Expr => ({ t: 'add', a, b });
export const sub = (a: Expr, b: Expr): Expr => ({ t: 'sub', a, b });
export const scale = (a: Expr, k: number): Expr => ({ t: 'scale', a, k });
export const max = (a: Expr, b: Expr): Expr => ({ t: 'max', a, b });
export const min = (a: Expr, b: Expr): Expr => ({ t: 'min', a, b });
/** Caps `a` above at `level` (min(a, level)). */
export const cap = (a: Expr, level: number): Expr => min(a, konst(level));
/** Floors `a` below at `level` (max(a, level)). */
export const floor = (a: Expr, level: number): Expr => max(a, konst(level));
export const ite = (cond: Cmp, a: Expr, b: Expr): Expr => ({ t: 'ite', cond, a, b });
export const indicator = (cond: Cmp): Expr => ({ t: 'ind', cond });

// --- Cmp builders ------------------------------------------------------------

export const alwaysTrue = (): Cmp => ({ t: 'true' });
export const alwaysFalse = (): Cmp => ({ t: 'false' });
export const gte = (a: Expr, b: Expr): Cmp => ({ t: 'gte', a, b });
export const gt = (a: Expr, b: Expr): Cmp => ({ t: 'gt', a, b });
export const lt = (a: Expr, b: Expr): Cmp => ({ t: 'lt', a, b });
export const lte = (a: Expr, b: Expr): Cmp => ({ t: 'lte', a, b });
export const and = (a: Cmp, b: Cmp): Cmp => ({ t: 'and', a, b });
export const or = (a: Cmp, b: Cmp): Cmp => ({ t: 'or', a, b });
export const not = (a: Cmp): Cmp => ({ t: 'not', a });
