import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/**
 * The commit the bundle was built from, short form.
 *
 * The app is a static site deployed on every push to main, so the bundle a
 * user has is the only record of which code is running. A revert or a failed
 * deploy changes that code and says nothing. Stamping the commit in means the
 * running version is readable from the page itself.
 *
 * Returns "unknown" when git is not available, for example a build from a
 * source archive with no repository. A build must never fail over a label.
 */
function gitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

// Set GITHUB_PAGES=1 when building for GitHub Pages project hosting.
export default defineConfig({
  plugins: [react()],
  base: process.env.GITHUB_PAGES ? '/EQSP-Pricer/' : '/',
  worker: { format: 'es' },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(gitCommit()),
    __APP_BUILT_AT__: JSON.stringify(new Date().toISOString()),
  },
});
