/**
 * Bundles the debug trace (`src/features/audit/trace.ts`, and the analysis code it replays) into one
 * self-contained script the harness injects into a page. The trace is not part of the extension: nothing in
 * `src/` imports it, so the production bundle never contains it.
 *
 *   node realworld/tools/build-trace.mjs   ->   realworld/.artifacts/trace.iife.js (global `__caTrace`)
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..', '..');
const require = createRequire(path.join(root, 'package.json'));
const vitePath = createRequire(require.resolve('vitest/package.json')).resolve('vite');
const { build } = await import(pathToFileURL(vitePath).href);

const result = await build({
  configFile: false,
  logLevel: 'error',
  root,
  resolve: {
    alias: {
      '@domain': path.join(root, 'src/domain'),
      '@core': path.join(root, 'src/core'),
      '@infrastructure': path.join(root, 'src/infrastructure'),
      '@features': path.join(root, 'src/features'),
      '@shared': path.join(root, 'src/shared'),
    },
  },
  build: {
    write: false,
    minify: false,
    lib: {
      entry: path.join(root, 'src/features/audit/trace.ts'),
      formats: ['iife'],
      name: '__caTrace',
      fileName: 'trace',
    },
  },
});
const output = (Array.isArray(result) ? result[0] : result).output[0];
const out = path.join(root, 'realworld', '.artifacts', 'trace.iife.js');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, output.code);
console.log(`trace bundle: ${output.code.length} bytes`);
