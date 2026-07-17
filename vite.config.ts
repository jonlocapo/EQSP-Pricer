import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Set GITHUB_PAGES=1 when building for GitHub Pages project hosting.
export default defineConfig({
  plugins: [react()],
  base: process.env.GITHUB_PAGES ? '/EQSP-Pricer/' : '/',
  worker: { format: 'es' },
});
