# Changelog

Versions are assigned per merged release, not per commit. The app shows its
version in the header, and the tooltip carries the exact commit, because a
static site redeploys on every push and otherwise gives no way to tell which
code is running.

The minor number moves on a release, and the patch number on a fix that does not
change pricing. A change that moves a price is never a patch.

## 1.0.0

The first version fit to quote from. The volatility model is built from price
history end to end, dividends and rates are measured rather than typed, and the
three bugs that made a price silently wrong are fixed.

- Per-step volatility. A path now diffuses at the volatility of its own step
  rather than one number taken at the final tenor, so a 5-year autocall that may
  call in year one is no longer simulated entirely on 5-year volatility. The
  schedule preserves total variance, so it is exact for the surface, and it is
  bit-identical when the surface has no term structure.
- Rate curve. Discounting and the path drift follow the term structure, using
  each step's instantaneous forward rate, instead of one overnight fixing held
  flat to maturity. EUR from the ECB, USD bootstrapped from FRED.
- GJR-GARCH(1,1) replaces GARCH(1,1), adding the leverage term, so a fall raises
  forecast volatility more than an equal rise.
- Fixed: the rate curve was overriding a quanto note's drift. It substituted the
  note currency's rate for the underlying's and dropped the equity-FX
  correlation term. Measured at -3.375% a year on a EUR note over a US
  underlying, roughly 15% of forward error at five years.
- Fixed: borrow cost was missing from the path-cache key. Borrow changes every
  path, so editing it against a warm cache silently reused stale paths and the
  price did not move. Measured at 23.76 points on the default note.
- Fixed: a stuck spinner, from the pending flag surviving a terminal transition.
- Fixed: currency and quanto handling on same-currency trades.
- Fixed: participation validation rejected a solve that landed exactly on a
  boundary.
- Fixed: a dividend yield that could not be measured now says why, instead of
  leaving a field that never moves.
- Dividend yield falls back to a tracking ETF for a price index with no
  total-return counterpart, and the fallback volatility estimator no longer
  fires a second identical request at the rate-limited chart endpoint.
- A failed solve now reports the range the note can actually reach.
- Fixed: ticker search reported "No matches" for real tickers. A relay error
  body passed the response check, won the hedged race, and aborted the routes
  still in flight. The empty result was then cached, and an empty array is
  truthy, so the query stayed broken until a page reload.
- Worst-of prerequisites: bivariate normal CDF, a two-asset worst-of digital and
  the Stulz formula as references, plus a draw-order fingerprint, cache-key
  coverage and frozen single-asset golden prices.

## 0.4.0

Dividends, skew and mobile. The last of the 0.x run-up.

- Dividend yield measured from price history rather than left at whatever was
  typed, taken from the gap between the adjusted close and the close.
- Skew surface, so a product is priced at the volatility of its own risk strike
  instead of one at-the-money number.
- Accumulator solve bounds respect the knock-out ordering, so a solve can no
  longer write back a strike the validator then rejects, which used to leave the
  form unrecoverable.
- The unconverged GARCH fallback reverts toward the unconditional level instead
  of holding a short-term estimate flat across the whole life.
- Mobile layout.
- Accent colour picker.

## 0.3.0

The volatility model, built from first principles.

- Volatility from price history: Yang-Zhang, with a GARCH(1,1) term structure
  and a volatility risk premium, replacing the reliance on option chains that
  were rarely reachable.
- A seven-rung source ladder, each rung falling through to the next, so one dead
  source never takes the pipeline down.
- Two-parameter pricing grid, in the manner of a spreadsheet data table.
- Hedged fetching across CORS relays, racing routes instead of trying them one
  at a time.

## 0.2.0

- Contract Lab: build a payoff from blocks.
- Trade history.
- Costs modelled explicitly: funding spread, borrow, retained fee.

## 0.1.0

- Monte Carlo engine: coupon products, participation notes, accumulators.
- Longstaff-Schwartz for issuer-callable notes.
- Path and observables caches, with the bit-identity contract the tests enforce.
- Solve-for on any single term.
