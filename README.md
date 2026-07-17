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

Indicative pricing only: flat volatility (no skew — materially understates barrier-product risk premia), single underlying, approximate business-day calendar, no credit/funding spread. Not investment advice.
