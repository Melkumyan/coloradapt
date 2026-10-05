import { defineConfig } from 'wxt';
import base from './wxt.config';

// Scratch: an unminified build with source maps in its own folder, for CPU profiling. Not committed.
export default defineConfig({
  ...(base as object),
  outDir: 'dist-profile',
  vite: (env) => {
    const b = (base as { vite: (e: typeof env) => Record<string, unknown> }).vite(env);
    return { ...b, build: { minify: false, sourcemap: true } };
  },
});
