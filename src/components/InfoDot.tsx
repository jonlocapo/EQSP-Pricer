import type { FetchLine } from './fetchFormat';

interface Props {
  /** What the last fetch reported for this field. Nothing renders when it is
   * undefined, so a field nobody fetched carries no dot at all. */
  text?: string;
  /** Colours the dot: a failure has to be visible without hovering. */
  kind?: FetchLine['kind'];
}

/**
 * The small circled `i` beside a field label, carrying what the last fetch
 * reported for THAT field.
 *
 * WHY THIS EXISTS. Every outcome used to stack into one block of prose under
 * the Fetch button: spot, rate, curve, volatility, each leg, the correlation
 * and the request count, in one run-on line. A reader who wants to know where
 * the volatility came from is looking at the volatility field, not at a log
 * three fields further down. The provenance now lives next to the number it
 * explains.
 *
 * The dot is a `<span>`, not a `<button>`. It is hover-only text with no
 * action behind it, so making it focusable would put a stop in the tab order
 * that leads nowhere. `aria-label` still exposes the text to a screen reader.
 */
export function InfoDot({ text, kind = 'ok' }: Props) {
  if (!text) return null;
  return (
    <span className={`info-dot info-dot-${kind}`} title={text} aria-label={text} role="note">
      i
    </span>
  );
}
