/**
 * Build stamp: which code is actually running.
 *
 * These three values are substituted at build time by Vite's `define` (see
 * vite.config.ts), so they cost nothing at runtime. They are plain string
 * literals in the bundle.
 *
 * WHY: the app is a static site that redeploys on every push to main. The
 * bundle a user has loaded is the only record of which code they are running,
 * and a revert or a failed deploy replaces that code silently. A version that
 * the page can show turns "the site is behaving oddly" into a fact anyone can
 * read and report.
 *
 * The version follows the CHANGELOG, and the commit identifies the exact
 * build, because several builds share one version number.
 */

declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare const __APP_BUILT_AT__: string;

/** Semantic version, matching package.json and the CHANGELOG. */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

/** Short commit hash, or "unknown" when the build had no git repository. */
export const APP_COMMIT: string = typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : 'unknown';

/** Build time, ISO 8601. */
export const APP_BUILT_AT: string = typeof __APP_BUILT_AT__ === 'string' ? __APP_BUILT_AT__ : '';

/** "v0.5.0", for the header badge. */
export function shortVersionLabel(): string {
  return `v${APP_VERSION}`;
}

/**
 * The full stamp, for the badge's tooltip: version, commit and build date.
 * Formats the date as a plain day, since the exact minute helps nobody.
 */
export function fullVersionLabel(): string {
  const built = APP_BUILT_AT ? APP_BUILT_AT.slice(0, 10) : 'unknown date';
  return `EQSP Pricer v${APP_VERSION} · commit ${APP_COMMIT} · built ${built}`;
}
