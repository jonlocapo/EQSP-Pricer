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
- **Worst-of baskets**, two to four underlyings, for the coupon and participation families. Validated against the Stulz closed form. Legs may sit in DIFFERENT currencies: each leg outside the note currency drifts at its own quanto drift, `r_leg - q_leg - borrow - rho(leg, FX) * vol_leg * volFX`. A leg missing those inputs is refused, never priced as if it were in the note currency.
- **Funding spread, borrow and fee** are modelled. A note discounts on the issuer's funding curve, not the risk-free curve.
- **Dividends and rates are measured**, not typed: dividends from the gap between the adjusted close and the close, rates from the ECB and FRED curves.
- **Twelve note currencies**: EUR, USD, GBP, CHF, JPY, HKD, SGD, AUD, CAD, SEK, NOK, DKK. Seven of them have a keyless official overnight fixing (EUR, USD, GBP, CHF, JPY, HKD, CAD); the rest price on a rate you type, and the fetch log says so rather than substituting another currency's rate. Only EUR and USD have a free multi-tenor zero curve.

What it still does not do:

- **No real holiday calendar.** The grid is a uniform 252 steps a year. Observation dates land on grid steps, not on exchange business days.
- **Prices are at-inception fair values.** All payoffs use performance relative to the initial fixing, so spot delta is structurally zero. Seasoned trades, where the current spot differs from the fixing, are not modelled.
- **No currency with capital controls or an NDF market** (INR, KRW, TWD, BRL, onshore CNY). Their forwards are NDF-based and carry an onshore/offshore basis this model has no term for, the quanto hedge is restricted, and the equity-FX correlation is measured against a rate that is not the one the hedge settles on. A desk quotes those notes by pricing the basis; this app would print a number nobody could trade on.
- **An accumulator is single-underlying**, permanently, which is a real product boundary rather than a gap.
- **Correlations fall back to 0.5** when they cannot be measured from history. The panel says which pairs are measured and which are defaulted.
- **A fair value is not a quote.** The retained fee is the main reason a bank's price is less aggressive than this one.
