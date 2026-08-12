# HANDOFF-FX — UI edits I could not make

Everything below is in files you own. I did not touch them. The engine, the
model, the fetch layer and the validation are done and green
(`npx tsc --noEmit`, `npm test` 591 passed / 11 skipped, `npm run build`).

---

## 0. The assumption you asked me to verify: YES, currencies flow through

`MarketPanel.tsx` line 13 imports `SUPPORTED_CURRENCIES as CURRENCIES` and line
584 renders `options={CURRENCIES.map((c) => ({ value: c, label: c }))}`. So the
seven currencies I added (HKD, SGD, AUD, CAD, SEK, NOK, DKK) appear in the
picker with no edit from you.

Two follow-on effects, both already correct, both worth knowing:

- `marketStore.setUnderlying` and `applyFetchedSpot` gate "the note currency
  follows the underlying" on `SUPPORTED_CURRENCIES.includes(currency)`. So
  picking a Hong Kong name now switches the note to HKD, where before it stayed
  EUR and made the trade a quanto. That is the intended behaviour.
- `fetchLiveData`'s `rateFor` rejects with "no open rate source for X. Enter
  manually." for any currency outside `REF_RATE_CCYS`. HKD and CAD now have
  real sources (HKMA overnight HIBOR, Bank of Canada CORRA). SGD, AUD, SEK, NOK
  and DKK do not, so they take that rejection path and the rate stays whatever
  the user typed. Nothing substitutes another currency's rate.

**One optional UI edit**: the rejection message is an error line in the fetch
log. For the five manual currencies it is expected, not a failure. Consider
pushing it as `kind: 'info'` with wording like
`Rate: no open source for NOK. Type it in the Rate field.` That is cosmetic; the
behaviour is already honest.

---

## 1. Per-leg quanto: the data the engine now needs

`BasketAsset` (src/model/market.ts) grew one optional field:

```ts
quanto?: LegQuantoParams; // { currency, rateUnderlying, fxVol, corrEqFx }
```

- **Absent means the leg is in the note currency.** A single-currency basket is
  bit-identical to before (pinned to 1e-9 in `tests/basketQuanto.test.ts`).
- **Present means the leg drifts at**
  `rateUnderlying - divYield - borrow - corrEqFx * vol * fxVol`, the single-name
  quanto formula, same sign convention.
- `market.quanto` still works and now means **leg 0's** block. `legQuantoOf`
  (exported from `src/model/market.ts`) is the single reader of both places; the
  leg's own block wins. So the primary leg keeps working through the code you
  already have, and you only need to populate legs 1 and up.

`buildBasket` (src/model/basket.ts) accepts `quanto` on a leg input and passes
it through, so the panel can keep building the basket the same way.

### Validation

`validateBasket` no longer refuses a currency mismatch. It now refuses:

- a leg whose currency differs from the note currency and has **no** quanto
  inputs — error key `currency{i}`;
- quanto inputs whose `currency` field does not match the leg's actual currency
  (stale inputs from a previous currency);
- `fxVol <= 0`, or `corrEqFx` outside [-1, 1];
- a leg back **in** the note currency that still carries quanto inputs — so
  clear `quanto` when a leg's currency changes to the note currency.

---

## 2. Fetching the per-leg FX inputs

New exported function in `src/services/marketFetch.ts`:

```ts
export async function fetchBasketLegFxParams(
  legs: { ticker: string; currency: string }[],
  noteCcy: string,
): Promise<{
  legs: (
    | { index: number; currency: string; fxVol: number; corrEqFx: number; days: number; source: string }
    | undefined
  )[];
  errors: string[];
}>;
```

It is `fetchFxRealizedVolAndCorr` generalised to N legs, with the same quoting
convention (FX = note currency per one unit of the leg's currency). It fetches
each distinct foreign currency's FX series **once**, so three US names in a EUR
note cost one EURUSD request. A leg already in the note currency comes back
`undefined` and costs no request at all. A leg that fails comes back
`undefined` with a message in `errors`; it never blocks the other legs.

### How to call it from `basketFetch.ts`

Inside `fetchExtraLegsLive`, after the per-leg vol ladder has run and each leg's
`currency` is populated, and before `populateBasketCorrelation`:

```ts
import { fetchBasketLegFxParams, fetchRefRate, REF_RATE_CCYS } from '../services/marketFetch';

const store = useMarketStore.getState();
const noteCcy = store.market.currency;
const all = [
  { ticker: store.ticker, currency: store.underlyingCurrency ?? noteCcy },
  ...store.extraLegs.map((l) => ({ ticker: l.ticker, currency: l.currency ?? noteCcy })),
];

const { legs: fx, errors } = await fetchBasketLegFxParams(all, noteCcy);
if (!isCurrent()) return lines;

// Index 0 is the PRIMARY leg. MarketPanel already writes its block through
// `setQuanto`, so leave it alone here and start at index 1.
for (let i = 1; i < all.length; i++) {
  const m = fx[i];
  const legCcy = all[i].currency;
  if (!m) {
    // Either the leg is in the note currency — then CLEAR any stale block —
    // or its measurement failed and `errors` says why.
    if (legCcy === noteCcy) store.setLeg(i - 1, { quanto: undefined });
    continue;
  }
  // The leg's OWN currency rate. No open source for most currencies, so fall
  // back to whatever the user typed for that leg, and never to the note rate.
  let rateUnderlying = store.extraLegs[i - 1].quanto?.rateUnderlying;
  if ((REF_RATE_CCYS as readonly string[]).includes(legCcy)) {
    try {
      rateUnderlying = (await fetchRefRate(legCcy)).rate;
    } catch {
      /* keep the typed value; the line below reports the gap */
    }
  }
  if (rateUnderlying === undefined) {
    lines.push({
      kind: 'info',
      msg: `${legLabel(store.extraLegs[i - 1], i - 1)}: no open ${legCcy} rate source. Type the leg's own rate before pricing.`,
    });
    continue; // Leave `quanto` unset: validateBasket then refuses the leg, which is correct.
  }
  store.setLeg(i - 1, {
    quanto: { currency: legCcy, rateUnderlying, fxVol: m.fxVol, corrEqFx: m.corrEqFx },
  });
  lines.push({
    kind: 'ok',
    msg:
      `${legLabel(store.extraLegs[i - 1], i - 1)} quanto (${legCcy}/${noteCcy}): ` +
      `rate ${(rateUnderlying * 100).toFixed(3)}%, FX vol ${(m.fxVol * 100).toFixed(2)}%, ` +
      `corr ${m.corrEqFx.toFixed(2)} · ${m.source}`,
  });
}
for (const e of errors) lines.push({ kind: 'info', msg: `Leg FX: ${e}. Type that leg's inputs before pricing.` });
```

**Do not default a missing `corrEqFx` to 0 or a missing `fxVol` to 0.1.** A zero
correlation is not neutral here — it silently removes the quanto correction.
Leaving `quanto` unset makes `validateBasket` block the price with a message
naming the leg, which is the honest outcome.

---

## 3. State and panel edits you need to make

### `src/state/marketStore.ts`

`BasketLegState` needs the field, so `setLeg` can write it and `buildBasket` can
read it:

```ts
import type { LegQuantoParams } from '../model/market';

export interface BasketLegState {
  // ...existing fields...
  /** Quanto inputs for this leg, when it trades outside the note currency.
   * Absent means the leg settles in the note currency and takes no FX
   * correction. Cleared whenever the leg's currency becomes the note
   * currency — `validateBasket` refuses a stale block. */
  quanto?: LegQuantoParams;
}
```

If the note currency changes (the `handleCurrencyChange` path), every leg's
`quanto` becomes stale: it was measured against the OLD note currency. Clear all
of them there, and re-run the fetch. This is the same failure the `finalCcy`
comment in `fetchLiveData` already describes for the rate, one level up.

### `src/components/MarketPanel.tsx`

1. Where the panel calls `buildBasket`, pass each extra leg's `quanto` through:
   `{ name, vol, divYield, volSurface, quanto: leg.quanto }`.
2. The note near line 684 and the block near line 729 say a basket can never be
   quanto. That is no longer true. Suggested replacement copy:
   *"Legs outside the note currency price as quanto legs: each one drifts at its
   own currency's rate, less its equity-FX covariance. Fetch live to measure the
   FX vol and correlation per leg."*
3. The quanto input group (`market.quanto`) is still exactly right for the
   PRIMARY leg. Label it as such once a basket exists, e.g. "Quanto — leg 1
   (RHM.DE, USD)", so it does not read as covering the whole basket.
4. The per-leg inputs (rate / FX vol / equity-FX correlation, three numbers per
   foreign leg) belong in `BasketPanel.tsx` or `BasketModal.tsx`, beside the
   leg's vol and dividend. They must be editable: five of the twelve currencies
   have no rate source, and the correlation is a judgement number a desk
   overrides.

### `src/components/BasketModal.tsx`

The comment at line 175 pointing at the old single-currency rule needs the same
update as item 2 above.

### `src/styles/app.css`

Line 704's comment says a currency mismatch is a silent-misprice risk. The
mismatch itself is now legal; what is flagged is a foreign leg with MISSING
quanto inputs. Same styling, different reason — only the comment needs the fix.

---

## 4. Capital-controls decision (so the UI copy matches)

I excluded INR, KRW, TWD, BRL and onshore CNY, and wrote the reasoning into the
`SUPPORTED_CURRENCIES` doc comment in `src/model/market.ts` and into README's
caveats. In short: those currencies trade offshore as non-deliverable forwards,
so the forward carries an onshore/offshore basis this model has no term for; the
quanto hedge is restricted by capital controls; and the equity-FX correlation
would be measured against an offshore rate that is not the fixing the hedge
settles on. Since they are not in the list, no UI warning copy is needed.
