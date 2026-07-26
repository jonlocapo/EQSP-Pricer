# EQSP Pricer: demo guide

A short guide for showing the pricer to someone who has not seen it before.
Written for a non-technical reader. No maths background needed.

---

## 1. What the thing is

EQSP Pricer is a pricing tool for equity structured products. You type the
terms of a note (underlying, tenor, barrier, coupon) and it tells you what the
note is worth, or what coupon you would need to pay to make it worth par.

Two things about it are unusual:

1. **It runs entirely in the browser.** No server, no install, no login. You
   open a web page and it works. Nothing you type leaves your machine.
2. **It answers in well under a second**, including the "solve for the coupon"
   case, which normally means running the whole calculation four or five times
   over.

The second point is the actual engineering achievement, and section 4 explains
why it is hard.

---

## 2. What it prices

Three product families, covering most of what a retail or private-bank desk
sells:

| Page | Products it covers |
| --- | --- |
| **Coupon** | Reverse convertible, Phoenix, autocall, memory coupon, snowball, issuer-callable note, airbag |
| **Participation** | Booster, bonus certificate, capital-guaranteed note, twin-win, call spread, knock-out with rebate |
| **Accumulator** | Accumulator (AQ) and decumulator (DQ), with gearing, knock-out and guarantee periods |

These are not separate models bolted together. Each page is one flexible
payoff description, and the named products are presets that fill it in. Adding
"defensive autocall" is a preset, not a new engine.

---

## 3. The demo flow

Three demos, about ninety seconds each. Do them in this order.

### Demo A: price a note (30 seconds)

1. Open the **Coupon** page. It loads with EURO STOXX 50 already selected and a
   one-year quarterly autocall pre-filled.
2. Click **fetch** on the market panel. The spot price, the currency, the
   interest rate and the volatility all fill in from live public data.
3. The price appears at the bottom without pressing anything. There is no
   "Price" button to hunt for. The result is live.

**What to point out:** the number updates as you type. Change the barrier from
60% to 65% and the price moves immediately.

### Demo B: solve for the coupon (the important one)

1. Click the **solve** chip next to the Coupon field. The field greys out. It is
   now an output, not an input.
2. The tool now answers a different question: not "what is this note worth" but
   "what coupon makes this note worth exactly 100%". That is the question a
   salesperson actually asks.
3. Now hold down the arrow on the **Barrier** field and watch the coupon track
   your clicks in real time.

**What to point out:** every one of those clicks is a full solve, which means
running the pricing model several times over, each time on a hundred thousand
simulated scenarios. It keeps up because of the caching described in section 4.
This is the part that no comparable open tool does.

### Demo C: costs and honesty

1. Open the **Costs** section in the market panel.
2. There are three inputs: issuer funding spread, borrow cost, and retained fee.
3. Move the fee from 0% to 2% and watch the solved coupon drop.

**What to point out:** most pricers give you a theoretical fair value and stop.
The gap between that fair value and the level a bank would actually show a
client is not a mystery, it is these three numbers. The tool models them
explicitly so you can see where the money goes. Note that the three costs do
not all push the same way: a funding spread and borrow cost let the issuer show
a *more* generous coupon, while the retained fee is what pulls the client's
level back down.

---

## 4. How the calculation works

### The basic idea, in plain terms

There is no formula for these products. A snowball autocall with a memory
coupon and a 60% American barrier cannot be written down as an equation, so the
industry standard answer is to simulate.

The tool does this:

1. **Invent a hundred thousand possible futures** for the underlying. Each one
   is a plausible price path from today to maturity, generated from the
   volatility number in the market panel.
2. **Walk each path through the contract.** Did it autocall in quarter two? Did
   it ever touch the barrier? What did the investor get paid, and when?
3. **Average the payoffs** across all hundred thousand futures, discounting each
   cash flow back to today at the interest rate.

That average is the price. The tool also reports a standard error, which is the
statistical uncertainty in that average. It is typically around 0.1% of
notional, and it is shown so nobody mistakes a simulation for an exact answer.

### The specific ingredients used

| Ingredient | What it is for |
| --- | --- |
| **Geometric Brownian motion** | The standard model for how a share price moves. It is what Black-Scholes assumes. |
| **Risk-neutral drift** | The paths grow at the interest rate, minus dividends, minus borrow cost. Not at an expected return. This is what makes the answer a *price* rather than a forecast. |
| **Antithetic variates** | For every random path, the mirror-image path is also simulated. Errors on the two sides cancel, so the answer is more accurate for the same amount of work. |
| **Longstaff-Schwartz** | Used only for issuer-callable notes. It works out, at each call date, whether the issuer would rationally call, by regressing future value on current level. |
| **A volatility surface** | Real option markets charge more for downside protection than for upside. A single flat volatility number underprices the short put in a barrier note, which makes the coupon look too generous. The tool builds a surface with a skew and prices each product at the volatility of its own dominant leg. |
| **Ridders root finding** | The solver behind the "solve for coupon" chip. It converges in three or four steps, and it warm-starts from the previous answer. |

### Why it is fast, which is the real story

The naive way to solve for a coupon is: guess a coupon, run a hundred thousand
simulations, see how far off you are, guess again, repeat. Four guesses means
four hundred thousand simulations. On the harder products that is about twenty
seconds, which is far too slow to feel interactive.

The insight is that **the simulated paths do not depend on the contract terms.**
The paths depend on the underlying, the volatility, the interest rate and the
tenor. They do not care what the coupon is. So the tool generates the paths
once, keeps them, and every subsequent guess just re-walks the *same* paths
through a slightly different contract.

Measured on this machine, one year, quarterly, one hundred thousand paths:

| | First calculation | After caching |
| --- | --- | --- |
| Price a European-barrier autocall | 861 ms | **100 ms** |
| Price an American-barrier autocall | 5005 ms | **75 ms** |
| Solve for the coupon (4 iterations) | 647 ms | **157 ms** |
| Solve on the American-barrier note | 2007 ms | **152 ms** |

The American-barrier row is the one to show. A five-second calculation becomes
a seventy-five millisecond one, and a solve that should have cost four of those
five-second runs lands in a sixth of a second.

Three further pieces make that hold up:

- **A second cache for path statistics.** Things like "the lowest level this
  path ever reached" are computed once and reused. That cache is keyed on the
  observation dates and the monitoring style, deliberately *not* on the barrier
  level, so dragging the barrier around still hits the cache.
- **Fewer time steps where fewer are correct.** A note that only looks at the
  underlying on four quarterly dates does not need 252 daily steps. Jumping
  straight between observation dates is mathematically exact here, not an
  approximation, and it is around sixty times less work. Products that watch
  the barrier every day, and accumulators, still get the full daily path.
- **Parallel workers.** The simulation is split across every processor core the
  machine has, and the split is arranged so the answer is identical to the
  single-core answer down to the ninth decimal place.

### How we know it is right

There is a test suite of over two hundred tests. The important ones are not
"does it run" tests:

- Products with a known closed-form answer (plain vanilla options, simple
  barriers) are checked against that formula.
- The cached answer is pinned against the uncached answer to nine decimal
  places, so a caching optimisation cannot quietly change a price.
- The fast time-grid is proved to give the identical answer to the slow one on
  the products where it is allowed, and the slow grid is enforced on the
  products where it is not.

The rule the codebase enforces is that a number may only move when the
economics say it should, and when that happens it is re-pinned deliberately.
A tolerance is never loosened to make a test pass.

---

## 5. What is different about this one

Compared with the open-source structured product pricers we looked at:

**Ahead on:**

- **Speed and interactivity.** The others price on a button press and take
  seconds. Nothing else caches paths across solver iterations, which is the
  thing that makes back-solving feel instant.
- **Variance reduction.** Antithetic sampling is standard on a real desk and
  largely absent from the open tools.
- **Cost modelling.** Funding spread, borrow and fee are modelled explicitly.
  Every comparable tool we found gives a theoretical fair value only, with no
  way to explain the gap to a real quote.
- **Back-solving.** Solving for coupon, barrier, participation, put strike or
  knock-out trigger is built in, not something you do by hand.
- **It is a product, not a notebook.** It runs in a browser with no setup.

**Behind on:**

- **Volatility modelling depth.** Some of the academic projects implement Heston
  and local volatility. We use a skewed surface plus a risk-strike rule, which
  captures the dominant effect and is honest about being an approximation.
- **Live market data.** We use free public sources, which are patchy outside US
  underlyings. This is the current work in progress.

---

## 6. What it does not do yet

Worth saying out loud before anyone finds it:

- **Prices are at inception.** It values a new trade. It does not value a note
  that was struck six months ago and is now seasoned.
- **Because of that, spot delta reads zero.** Every payoff is written in terms
  of performance against the initial fixing, so scaling the starting level
  scales nothing. That is correct for a new trade, and it stops being correct
  the moment we add seasoned pricing.
- **Single underlying.** No worst-of baskets yet. The structure to support them
  is in place.
- **The market data pipeline is the weak link.** Free option data is unreliable.
  There is active work on a layered fallback so a sensible volatility is always
  available, and so the app always says which source it used.

---

## 7. Questions he is likely to ask

**"How do I know the numbers are right?"**
Three ways. Where a textbook formula exists, we check against it. Where it does
not, we check the fast path against the slow path to nine decimal places. And
the simulation reports its own error bar, so you can see the uncertainty rather
than having to trust a single figure.

**"How accurate is a hundred thousand simulations?"**
The typical error is around one tenth of one percent of notional. Four times as
many simulations would halve it. That is a deliberate trade: the current setting
is the point where the answer is accurate enough to trade off and fast enough to
feel live.

**"Why is this faster than what a bank uses?"**
It is not solving a harder problem than a bank's system. It is solving a narrow
problem very well. A bank's engine has to handle every asset class, every
booking system and an overnight risk run. This does one product family, in one
process, with everything held in memory, so it can cache aggressively in a way a
large shared system cannot.

**"Can we trust a price that comes out of a browser?"**
The calculation is the same calculation regardless of where it runs. Running in
the browser means no data leaves the user's machine and there is no server cost
per user. The trade-off is memory, and the caching work above is what keeps the
memory footprint small enough.

**"Why does our price differ from the bank's quote?"**
Three reasons, and they are all visible in the tool. First, volatility: a bank
prices the downside on its own skew, and our surface is an approximation of
theirs. Second, the cost inputs: funding, borrow and fee. Third, the bank's
margin, which is the fee field. Set those three and the numbers converge.

**"Why does a higher put strike give a lower price?"**
Because the investor is short that put. A higher strike means the investor
starts losing money sooner, so the note is worth less to the investor, which
means the issuer must pay a bigger coupon to bring it back to par.

**"What happens if the market data fetch fails?"**
It tells you, and it falls back. It can build a volatility estimate from the
underlying's own price history when no option data is available, and it labels
the result so nobody mistakes an estimate for a market quote. Every field is
also manually overridable.

**"Can it price something we have not thought of yet?"**
Increasingly, yes. Underneath the three product pages there is a set of building
blocks (a coupon, a barrier, a call trigger, a put) that can be assembled into
new payoffs. It is proved to give bit-for-bit identical answers to the
hand-written products, and it is what would let us add something like a catapult
without writing a new pricer. It is behind a small entry point in the app for
now, because the market data has to be dependable before we let people build
arbitrary contracts with it.

**"What would it take to make this a real product?"**
The honest list is: dependable market data (paid feed, which is a cost not an
engineering problem), seasoned trade pricing, multi-asset worst-of, and a risk
report. The pricing engine itself is the part that is done.

**"What is the risk report you keep mentioning?"**
Showing not just the price but the distribution of outcomes: probability of
autocall by date, probability of capital loss, expected loss given a breach. The
engine already computes this because it has all hundred thousand outcomes in
hand. It is deliberately out of scope for now, and it is arguably a separate
product.
