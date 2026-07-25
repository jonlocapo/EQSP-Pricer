# EQSP Pricer — contributor notes

A browser-based Monte Carlo pricer for equity structured products. Pure
client-side TypeScript + React + Vite; the pricing engine runs in a Web Worker.

## Comment style — ASD-STE100 Simplified Technical English

Write every comment in Simplified Technical English. STE permits domain
**Technical Names** and **Technical Verbs**, so keep the vocabulary the maths
needs (quanto, antithetic, Longstaff-Schwartz, knock-in, autocall, discount
factor, implied volatility, stderr). Apply the writing rules:

- **Short sentences.** Aim for 20 words or fewer in an instruction, 25 in a
  description. Split a compound sentence into two.
- **One idea per sentence.**
- **Active voice.** Name the actor: "the solver caches paths", not "paths are
  cached".
- **Imperative for instructions.** "Do not cache the LSMC branch."
- **Present tense**, simple verb forms. Avoid stacked `-ing` clauses.
- **One term per concept.** Do not alternate between "path" and "trajectory".
- **No unclear "it"/"this"/"that".** Name the noun.
- **Keep the content.** Rephrase; do not delete an explanation to shorten it.

Meaning wins over compliance. These comments carry load-bearing financial and
numerical reasoning — the quanto drift derivation, the slice/seed/pooling
invariant, why a cache is bit-identical. If STE phrasing would blur a technical
meaning, keep the longer wording. A verbose correct comment beats a compliant
wrong one.

## Correctness discipline

The engine has a standing bit-identity contract, and several tests exist purely
to enforce it. Before changing anything under `src/engine/` or `src/worker/`:

- `tests/pathCache.test.ts` pins pv **and** stderr to 1e-9 for a fixed
  spec/seed, and independently reimplements the slice/pooling loop as a
  reference. `stderr` is the value most at risk in any pooling change — assert
  it explicitly, never just pv.
- `tests/observables.test.ts` asserts `phaseB(phaseA(path))` is `===`-equal to
  the monolithic evaluator, field by field, across many spec variants.
- `tests/adaptiveGrid.test.ts` proves the compact-grid speedup is exact for
  European monitoring, and `tests/schedule.test.ts` guards that American
  monitoring still gets a daily grid. Making barrier monitoring coarse is a
  real mispricing.
- `tests/combinators.test.ts` holds the combinator engine bit-identical to the
  hand-written evaluators.

If a change moves a number, it must be because the economics say so. State why
in the commit, re-pin the golden value deliberately in the same commit, and
validate against a closed form (`tests/mcVanilla.test.ts`,
`tests/mcBarrier.test.ts`). **Never loosen a tolerance to make a test pass.**

## Performance

Run `npm run bench` before and after any engine change; it reports cold price,
warm reprice, and solve timings for the three families. Speed claims belong in
numbers, not adjectives.

Two caches carry the interactive feel, and both key on what actually matters:

- the **path cache** keys on market data, MC settings, and grid shape — not on
  product terms — so a solve-for reuses paths across every iteration;
- the **observables cache** keys additionally on the observation schedule and
  the monitoring-mode requirements, never on barrier *levels*, so a
  barrier solve still hits it.

## Model scope

Prices are at-inception fair values. All payoffs use relative performance
`spots[i] / spots[0]`, which is scale-invariant in the starting level, so
**spot delta is structurally zero** — that is correct here, not a bug. It stops
being zero only once the model separates the initial fixing from current spot
(seasoned trades), which is not implemented.

A fair value is not a bank's quote. Costs are modelled explicitly in
`CostParams` and their signs differ: a funding spread makes an issuer quote
*more* generously, borrow makes it *less*, and the retained fee is the main
reason a real quote is less aggressive than fair value.

## Verification

`npx tsc --noEmit`, `npm test`, and `npm run build` must all be clean. For
UI-visible work, drive the real app rather than trusting the logic — poll the
DOM in a browser pass against `npm run preview`. That practice has caught
several real bugs that reading the code did not.
