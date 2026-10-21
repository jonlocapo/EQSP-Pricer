import type { FetchLine } from './fetchFormat';

interface Props {
  /** What the last fetch reported for this field. Nothing renders when it is
   * undefined, so a field nobody fetched carries no dot at all. */
  text?: string;
  /** Colours the dot: a failure has to be visible without hovering. */
  kind?: FetchLine['kind'];
  /** Set this flag when the dot sits INSIDE a control that carries the same
   * text on its own `title`. The dot then has no `title` and no label, and
   * screen readers skip it.
   *
   * A `title` on the dot hides the parent's `title` over the dot's 13px. A
   * user who hovers the dot then gets the dot's tooltip, and a user who
   * hovers the rest of the control gets the control's tooltip. Two targets
   * for one piece of text made the hover unreliable. One `title` on the
   * whole control gives one large target. */
  decorative?: boolean;
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
export function InfoDot({ text, kind = 'ok', decorative = false }: Props) {
  if (!text) return null;
  if (decorative) {
    return (
      <span className={`info-dot info-dot-${kind} info-dot-decorative`} aria-hidden="true">
        i
      </span>
    );
  }
  return (
    <span className={`info-dot info-dot-${kind}`} title={text} aria-label={text} role="note">
      i
    </span>
  );
}
