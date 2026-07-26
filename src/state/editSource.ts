/**
 * Tracks HOW the most recent spec edit was made, so live repricing can pick
 * an appropriate debounce.
 *
 * The two input styles have opposite needs:
 * - Stepper buttons emit a burst of individually complete values; each tick
 *   is a valid number the user meant. So they want a SHORT wait, just long
 *   enough to collapse a burst of clicks into one run.
 * - Typing passes through meaningless intermediate states. Clearing the "8"
 *   of "80" to type "70" transiently reads 0. So typing wants a LONGER
 *   wait, or the engine burns a full solve on a number the user never
 *   intended.
 *
 * This lives outside the React store deliberately. It is transient input
 * metadata, not application state. Putting it in the store would trigger a
 * re-render of every subscriber on each keystroke, for no benefit.
 */

export type EditSource = 'type' | 'step';

/** How long a source marker stays trustworthy. Any edit that reaches the
 * live-reprice hook later than this did not come from a field we
 * instrumented, for example a segmented control, a preset button, or a
 * market-data fetch. So it falls back to the conservative longer wait. */
const FRESHNESS_MS = 1000;

let lastSource: EditSource = 'type';
let lastAt = 0;

/** Called by an input immediately before it propagates a new value upward. */
export function noteEditSource(source: EditSource): void {
  lastSource = source;
  lastAt = Date.now();
}

/** The source of the edit currently being processed, or 'type' if the marker
 * is stale (see FRESHNESS_MS). Non-destructive: several subscribers may
 * read it for the same edit. */
export function peekEditSource(): EditSource {
  return Date.now() - lastAt < FRESHNESS_MS ? lastSource : 'type';
}

/** Test-only: clears the marker so cases don't leak state into each other. */
export function __resetEditSourceForTests(): void {
  lastSource = 'type';
  lastAt = 0;
}
