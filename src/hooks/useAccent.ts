import { useCallback, useEffect, useState } from 'react';
import { ACCENTS, DEFAULT_ACCENT_ID, accentById, accentVars } from '../theme/accents';

const STORAGE_KEY = 'eqsp.accentId';

/**
 * Reads the accent the user last chose. An unknown or absent id degrades to
 * the default, so a stale value from an older build cannot leave the app with
 * no accent at all.
 */
function readStoredAccentId(): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && ACCENTS.some((a) => a.id === raw)) return raw;
  } catch {
    // Private browsing can make localStorage throw on read. Use the default.
  }
  return DEFAULT_ACCENT_ID;
}

/** The theme the page is currently rendering in. The app follows the OS. */
function currentTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Writes the four accent variables onto the document root as INLINE styles.
 *
 * An inline style on `:root` beats every selector in the stylesheet, including
 * the `prefers-color-scheme` media block. So one write covers both themes, and
 * the theme only decides WHICH values to write. The theme listener below
 * rewrites them when the OS switches.
 */
function applyAccent(id: string, theme: 'light' | 'dark'): void {
  const vars = accentVars(accentById(id).base, theme);
  const root = document.documentElement.style;
  root.setProperty('--accent', vars.accent);
  root.setProperty('--accent-hover', vars.accentHover);
  root.setProperty('--accent-soft', vars.accentSoft);
  root.setProperty('--accent-contrast', vars.accentContrast);
}

export interface UseAccentResult {
  accentId: string;
  setAccentId: (id: string) => void;
}

/**
 * Keeps the chosen accent applied and persisted. Re-applies on an OS theme
 * change, because the dark variant lightens the base and the light variant
 * does not.
 */
export function useAccent(): UseAccentResult {
  const [accentId, setAccentIdState] = useState(readStoredAccentId);

  useEffect(() => {
    applyAccent(accentId, currentTheme());
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onThemeChange = () => applyAccent(accentId, currentTheme());
    media.addEventListener('change', onThemeChange);
    return () => media.removeEventListener('change', onThemeChange);
  }, [accentId]);

  const setAccentId = useCallback((id: string) => {
    setAccentIdState(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // A failed write only costs persistence, so keep the live change.
    }
  }, []);

  return { accentId, setAccentId };
}

/**
 * Calls `onFire` on the accent picker's shortcut: Alt+Shift+A, which is
 * Option+Shift+A on a Mac.
 *
 * WHY this combination. It behaves the same on both platforms, so there is no
 * Command-versus-Control branch to get wrong. It is also unclaimed: the
 * Command/Control+Shift pairs a picker would otherwise want are taken by the
 * browsers themselves, for example Control/Command+Shift+A opens tab search in
 * Chrome and Control+Shift+P opens a private window in Firefox.
 *
 * The listener matches `event.code`, not `event.key`. Holding Option on a Mac
 * rewrites `key` to the character the combination would type, so Option+Shift+A
 * arrives as "Å". `code` names the physical key and stays "KeyA" under every
 * modifier and keyboard layout.
 */
export function useAccentShortcut(onFire: () => void): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyA') {
        e.preventDefault();
        onFire();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onFire]);
}
