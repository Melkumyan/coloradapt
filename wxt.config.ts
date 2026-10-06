import path from 'node:path';
import { defineConfig } from 'wxt';

const root = import.meta.dirname;

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  outDir: 'dist',
  manifest: ({ browser }) => ({
    name: 'ColorAdapt',
    description:
      'Adapts web pages for people with color vision deficiencies by detecting and fixing hard-to-distinguish color combinations.',
    permissions: ['storage'],
    host_permissions: ['http://*/*', 'https://*/*'],
    // Firefox only (Chromium ignores the key and WXT leaves it out): a stable add-on id gives the
    // extension a stable moz-extension:// origin and is required for MV3 and for signing. The id
    // is a placeholder until the extension is published (M13, Store Release). The extension collects nothing.
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'coloradapt@coloradapt.invalid',
              data_collection_permissions: { required: ['none'] },
            },
          },
        }
      : {}),
  }),
  vite: ({ mode }) => ({
    // `wxt build --mode e2e` (docs/DEVELOPMENT.md) is the shipped build plus one thing: the analyzer
    // runs on a logical clock (features/page-analysis/build-mode.ts). Vite would otherwise treat any
    // mode but `production` as development (React dev build, `import.meta.env.DEV`), which E2E must
    // not test instead of what ships.
    ...(mode === 'e2e'
      ? {
          define: {
            'import.meta.env.DEV': 'false',
            'import.meta.env.PROD': 'true',
            'process.env.NODE_ENV': '"production"',
          },
          // The React runtime above is the production one, which has no `jsxDEV`: compile JSX for it too
          // (Vite would otherwise emit the development transform for any mode but `production`).
          oxc: { jsx: { development: false } },
        }
      : {}),
    resolve: {
      alias: {
        '@domain': path.resolve(root, 'src/domain'),
        '@core': path.resolve(root, 'src/core'),
        '@infrastructure': path.resolve(root, 'src/infrastructure'),
        '@features': path.resolve(root, 'src/features'),
        '@shared': path.resolve(root, 'src/shared'),
      },
    },
  }),
});
