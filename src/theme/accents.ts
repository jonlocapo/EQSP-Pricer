/**
 * The accent palette, and the colour maths that turns one base hex into the
 * four CSS custom properties the stylesheet reads.
 *
 * WHY derive instead of hand-authoring: the stylesheet needs `--accent`,
 * `--accent-hover`, `--accent-soft` and `--accent-contrast`, in a light and a
 * dark variant. Six accents would mean forty-eight hand-picked hex values to
 * keep consistent. So each accent stores ONE base colour, and this module
 * derives the rest. A new accent costs one line.
 *
 * `--accent-contrast` exists because the stylesheet paints text directly onto
 * `--accent` on primary buttons and active pills. White text reads well on the
 * indigo default but fails on the gold and the lime, so the foreground must
 * follow the accent's own luminance instead of staying a fixed colour.
 */

export interface Accent {
  id: string;
  /** Shown under the swatch in the picker. */
  name: string;
  /** The light-theme base. The dark-theme accent is lightened from this. */
  base: string;
}

/**
 * The six accents. `reoffer` is the app's original indigo, kept first so the
 * default stays one keystroke away.
 */
export const ACCENTS: Accent[] = [
  { id: 'reoffer', name: 'Reoffer', base: '#435bf3' },
  { id: 'knockin', name: 'Knock-In', base: '#c44b21' },
  { id: 'phoenix', name: 'Phoenix', base: '#c64184' },
  { id: 'twinwin', name: 'Twin-Win', base: '#9361ea' },
  { id: 'coupon', name: 'Coupon', base: '#dda024' },
  { id: 'catapult', name: 'Catapult', base: '#b4d933' },
];

export const DEFAULT_ACCENT_ID = 'reoffer';

export function accentById(id: string): Accent {
  return ACCENTS.find((a) => a.id === id) ?? ACCENTS[0];
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: string): Rgb {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function toHex({ r, g, b }: Rgb): string {
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/** Blends `colour` towards `target` by `amount` in [0, 1]. */
function mix(colour: Rgb, target: Rgb, amount: number): Rgb {
  return {
    r: colour.r + (target.r - colour.r) * amount,
    g: colour.g + (target.g - colour.g) * amount,
    b: colour.b + (target.b - colour.b) * amount,
  };
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/**
 * WCAG relative luminance. Used only to choose between a light and a dark
 * foreground, so the sRGB gamma step matters and a simple average does not:
 * the gold and the lime are much brighter than their raw byte values suggest.
 */
function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** A near-black rather than pure black, matching the stylesheet's `--text`. */
const DARK_FOREGROUND = '#16181d';

/**
 * Foreground for text painted onto `background`. The 0.45 threshold sits
 * above the luminance of every accent that reads well under white text and
 * below the gold's, so the gold and the lime get dark text and the rest keep
 * white.
 */
export function contrastOn(background: string): string {
  return relativeLuminance(parseHex(background)) > 0.45 ? DARK_FOREGROUND : '#ffffff';
}

export interface AccentVars {
  accent: string;
  accentHover: string;
  accentSoft: string;
  accentContrast: string;
}

/**
 * The four accent variables for one accent in one theme.
 *
 * Light theme keeps the base, darkens for hover, and tints far towards white
 * for the soft fill. Dark theme lightens the base first, because a saturated
 * mid-tone loses too much contrast against the dark background, then lightens
 * further for hover and shades far towards black for the soft fill. The
 * lighten amounts reproduce the app's original indigo pair (#435bf3 light,
 * #8195f7 dark) closely enough that the default accent looks unchanged.
 */
export function accentVars(base: string, theme: 'light' | 'dark'): AccentVars {
  const rgb = parseHex(base);
  if (theme === 'light') {
    const accent = toHex(rgb);
    return {
      accent,
      accentHover: toHex(mix(rgb, BLACK, 0.12)),
      accentSoft: toHex(mix(rgb, WHITE, 0.9)),
      accentContrast: contrastOn(accent),
    };
  }
  const lightened = mix(rgb, WHITE, 0.3);
  const accent = toHex(lightened);
  return {
    accent,
    accentHover: toHex(mix(rgb, WHITE, 0.45)),
    accentSoft: toHex(mix(rgb, BLACK, 0.65)),
    accentContrast: contrastOn(accent),
  };
}
