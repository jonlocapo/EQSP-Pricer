/**
 * A volatility surface whose SKEW comes from a direct slope parameterisation,
 * not from realized third and fourth moments.
 *
 * WHY: ../model/realizedSurface.ts builds its wing from the measured
 * skewness and kurtosis of PAST returns, through a Gram-Charlier expansion.
 * Realized skew badly understates traded skew, and two separate failure
 * modes compound on top of that:
 *
 *  1. Converting a market-observed 30-day risk-neutral skewness into the
 *     Gram-Charlier expansion's `skewDaily` parameter, through the i.i.d.
 *     scaling rule skewT = skewDaily / sqrt(n), makes the resulting strike
 *     premium decay as 1/T. beta(T) below decays instead as T^(-0.5), which
 *     gives the strike premium the empirical 1/sqrt(T) decay directly, and
 *     is far more defensible across a 1-month-to-5-year range.
 *  2. A realistic 30-day risk-neutral skewness (about -4) drives the
 *     Gram-Charlier factor outside the small-perturbation regime that
 *     expansion is only valid in.
 *
 * So this module parameterises the wing directly, instead of deriving it
 * from moments:
 *
 *     sigma(k, T) = sigma_atm(T) * (1 + beta(T) * (-k) + gamma(T) * k^2)
 *     k = ln(K / F)          <- log-moneyness against the FORWARD, not spot
 *     beta(T)  = beta1y * T^(-0.5)
 *     gamma(T) = beta(T) / 2
 *
 * `-k` is positive below the forward, so a positive beta1y lifts vol on the
 * downside, the side a knock-in barrier sits on.
 *
 * WHERE beta1y COMES FROM: this module does NOT fetch a live market skew
 * reading. `DEFAULT_BETA_1Y` is a single static, documented constant
 * instead. See its own comment for the arithmetic that produced it, and for
 * how to recalibrate it by hand.
 *
 * Do NOT feed a measured skewness into the Gram-Charlier `skewDaily`
 * parameter as a shortcut to this shape. That path is `buildRealizedSurface`
 * in ./realizedSurface.ts, and it stays, as the tested fallback for callers
 * that want realized-moment skew on purpose. Keep the two paths separate.
 */
import { DEFAULT_STRIKE_PCTS, clampVol } from './realizedSurface';
import type { VolSurface } from './volSurface';

/**
 * Calibration constant.
 *
 * beta1y = KAPPA * (SKEW - 100) / 10, where SKEW is the CBOE SKEW index
 * level and KAPPA = 0.2268 is chosen so a SKEW of 139.55, a typical index
 * reading, produces a +4.00 vol point premium at the 80% strike, one year,
 * on a 20% ATM vol:
 *
 *     KAPPA = 0.2268
 *     SKEW  = 139.55
 *     beta1y = 0.2268 * (139.55 - 100) / 10 = 0.2268 * 3.955 = 0.897
 *
 * The ABSOLUTE LEVEL here is a judgement, calibrated to a typical index
 * skew reading, not a live measurement: there is no market fetch behind it.
 * This is the single number to change to make the whole surface's skew
 * steeper or shallower. To recalibrate to a different SKEW level S',
 * compute 0.2268 * (S' - 100) / 10 and replace the literal below.
 */
export const DEFAULT_BETA_1Y = 0.897;

/**
 * CBOE SKEW measures SPX INDEX skew, which is systematically steeper than
 * single-name skew: index skew embeds correlation risk, a market-wide
 * selloff moves every constituent down together, a risk a single stock does
 * not carry on its own. Applying the index beta1y undamped to a single name
 * therefore overstates its wing. This factor damps it instead. 0.7 is a
 * starting judgement, not a measurement. Label the surface so the UI states
 * which case applied.
 */
export const SINGLE_NAME_SKEW_DAMPING = 0.7;

/**
 * The beta1y to use for one underlying: the static calibration above,
 * damped for a single name, and floored at zero.
 *
 * The floor matters. beta1y must never go negative, because a negative
 * beta1y would invert the smile: it would put LOWER vol at the downside
 * barrier than at the money, understating the short put in a knock-in, and
 * so understating the coupon, the exact error this module exists to
 * correct, with the sign flipped. Equity risk-neutral skewness is negative
 * essentially always (SKEW above 100 in every normal market), so this floor
 * is a backstop against a mis-set constant, not a case expected to bind on
 * real market data.
 */
export function effectiveBeta1y(isIndex: boolean, beta1y: number = DEFAULT_BETA_1Y): number {
  const floored = Math.max(0, beta1y);
  return isIndex ? floored : floored * SINGLE_NAME_SKEW_DAMPING;
}

/** Forward price at maturity T, from spot, the continuously compounded rate
 * and the continuous dividend yield. `k` is log-moneyness against THIS, not
 * against spot: pricing a knock-in against a spot-relative strike ignores
 * the cost of carry between now and the barrier's observation date. */
function forwardOf(spot: number, rate: number, divYield: number, tYears: number): number {
  return spot * Math.exp((rate - divYield) * tYears);
}

/**
 * Builds a surface from the slope parameterisation above.
 *
 * `terms` supplies the ATM level and term structure exactly as measured
 * elsewhere, Yang-Zhang plus GARCH, VRP-scaled, see volPipeline.ts. This
 * function changes only the SHAPE across strike, never the level: each
 * slice's ATM point (K = F) still reads back the term's own `vol` exactly,
 * because at k = 0 the parenthesized factor is 1.
 *
 * `strikePcts` matches ../model/realizedSurface.ts's DEFAULT_STRIKE_PCTS, so
 * both smile builders tabulate at the same strikes and a caller can swap one
 * for the other without changing the grid the rest of the surface reads.
 *
 * The clamp band (see ../model/realizedSurface.ts's clampVol) is kept as a
 * backstop against a badly mis-set beta1y. It is not expected to bind inside
 * the 60% to 140% strike band at one year or longer with the default
 * calibration; see tests/skewSurface.test.ts.
 */
export function buildSkewSurface(
  spot: number,
  terms: { tYears: number; vol: number }[],
  beta1y: number,
  rate: number,
  divYield: number,
  source: string,
  strikePcts: number[] = DEFAULT_STRIKE_PCTS,
): VolSurface {
  if (!(spot > 0)) throw new Error('Cannot build a skew surface without a positive spot');
  if (terms.length === 0) throw new Error('Not enough term structure to build a skew surface');

  // Backstop floor: see effectiveBeta1y's comment. Callers normally pass an
  // already-floored value, but this function must never invert the smile
  // even if one does not.
  const beta1yUsed = Math.max(0, beta1y);

  const slices = terms.map(({ tYears, vol }) => {
    const beta = beta1yUsed / Math.sqrt(tYears);
    const gamma = beta / 2;
    const forward = forwardOf(spot, rate, divYield, tYears);
    const points = strikePcts.map((pct) => {
      const strike = (pct / 100) * spot;
      const k = Math.log(strike / forward);
      const iv = vol * (1 + beta * -k + gamma * k * k);
      return { strike, iv: clampVol(iv, vol) };
    });
    return { tYears, points };
  });

  // Flat only when the effective beta1y is exactly zero, the same
  // "no strike skew" convention buildRealizedSurface uses for its own
  // isFlat flag.
  return { spotRef: spot, slices, source, isFlat: beta1yUsed === 0 };
}
