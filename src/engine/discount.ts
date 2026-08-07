/** Discount factors. The engine prices the note's cashflows with the
 * issuer's funding curve: the reference rate (possibly a curve) plus the
 * funding spread. */
import type { RatePoint } from '../model/market';

/**
 * The zero rate at time `t` from a curve, ascending by tYears. Linear in t
 * between points, flat outside the quoted range — never extrapolated, the
 * same discipline as the vol surface's maturity handling. Points are zero
 * rates, so a cashflow at `t` discounts with `exp(-r(t) * t)`.
 */
export function rateAt(curve: RatePoint[], t: number): number {
  if (curve.length === 0) throw new Error('cannot read an empty rate curve');
  if (t <= curve[0].tYears) return curve[0].rate;
  const last = curve[curve.length - 1];
  if (t >= last.tYears) return last.rate;
  for (let i = 1; i < curve.length; i++) {
    const b = curve[i];
    if (t <= b.tYears) {
      const a = curve[i - 1];
      const w = (t - a.tYears) / (b.tYears - a.tYears);
      return a.rate + w * (b.rate - a.rate);
    }
  }
  return last.rate;
}

/**
 * Flat continuously-compounded discounting on `rate`, or curve-based when
 * `curve` is given. The funding spread applies at every tenor either way:
 * an issuer discounts its liability on its funding curve, which is what
 * makes a wide-funding issuer able to pay a higher coupon.
 *
 * BIT-IDENTITY: the no-curve path computes `exp(-(rate + spread) * t)`
 * with `spread = fundingSpreadBp / 10_000`, the exact same operand order as
 * the previous `makeDf(discountRate(market))` — `discountRate` is precisely
 * `rate + fundingSpreadBp / 10_000`. So every existing caller that passes a
 * plain rate keeps bit-identical discount factors.
 */
export function makeDf(rate: number, curve?: RatePoint[], fundingSpreadBp = 0): (t: number) => number {
  const spread = fundingSpreadBp / 10_000;
  if (!curve || curve.length === 0) {
    return (t: number) => Math.exp(-(rate + spread) * t);
  }
  return (t: number) => Math.exp(-(rateAt(curve, t) + spread) * t);
}
