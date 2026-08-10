# EQSP Pricer

Browser-based indicative pricer for equity structured products. Everything runs client-side: a risk-neutral Black-Scholes Monte Carlo engine (100k paths, daily steps, antithetic variates, seeded PRNG) executes in a Web Worker, with solve-for via bracketed root-finding on common random numbers.

## Products

- **Coupon (RC/AC)** — reverse convertibles and autocallables: European/American/no KI barrier, geared put downside, fixed/conditional/memory (Phoenix) coupons, constant/step-down/custom-per-period autocall barriers, issuer callables (priced by Longstaff-Schwartz least-squares MC), autocall coupon. Solve for coupon, AC coupon, coupon barrier, call barrier, KI barrier, or price.
- **Participation** — Booster, Bonus, Capital Guaranteed, Twin Win; on all subtypes the upside can be vanilla, call spread (upper strike), or KO + rebate (shark-fin, American/European monitoring), and the downside can carry a put-spread loss floor. Solve for the headline parameter (gearing / bonus level / participation / part-up), upper strike, KO barrier, rebate, or price.
- **Accumulator** — daily accumulation with 1x/2x gearing below strike, KO trigger with KO+0/KO+1/period-end settlement, guarantee periods, weekly/monthly settlement. Solve for strike or upfront.

Market data (spot, flat vol, rate, dividend yield) is entered manually; a best-effort delayed spot fetch (Stooq, with a CORS-proxy fallback) is available. Results show PV, standard error, 95% CI, optional bump-and-reprice delta/vega, and diagnostics (per-period call probability, P(KI), KO probabilities, expected life). Every run is stored in a local pricing history.

## Development

```bash
npm install
npm run dev      # dev server
npm test         # vitest: MC vs closed-form benchmarks, payoff unit tests, solver tests
npm run build    # static bundle in dist/
```

Deploy `dist/` to any static host (Vercel/Netlify zero-config; for GitHub Pages set `GITHUB_PAGES=1` at build time to get the `/EQSP-Pricer/` base path).

## Caveats

Indicative pricing only. Not investment advice.

What the model does now:

- **Volatility carries a skew and a term structure.** It is built from price history (Yang-Zhang plus GJR-GARCH, scaled by a volatility risk premium) when no option chain is reachable, and each product prices at the volatility of its own risk strike rather than one at-the-money number.
- **Worst-of baskets**, two to four underlyings, for the coupon and participation families. Validated against the Stulz closed form.
- **Funding spread, borrow and fee** are modelled. A note discounts on the issuer's funding curve, not the risk-free curve.
- **Dividends and rates are measured**, not typed: dividends from the gap between the adjusted close and the close, rates from the ECB and FRED curves.

What it still does not do:

- **No real holiday calendar.** The grid is a uniform 252 steps a year. Observation dates land on grid steps, not on exchange business days.
- **Prices are at-inception fair values.** All payoffs use performance relative to the initial fixing, so spot delta is structurally zero. Seasoned trades, where the current spot differs from the fixing, are not modelled.
- **A worst-of must be single-currency.** A quanto correction needs one equity-FX correlation per leg, and the model carries one, so a multi-currency basket is refused rather than approximated.
- **An accumulator is single-underlying**, permanently, which is a real product boundary rather than a gap.
- **Correlations fall back to 0.5** when they cannot be measured from history. The panel says which pairs are measured and which are defaulted.
- **A fair value is not a quote.** The retained fee is the main reason a bank's price is less aggressive than this one.
