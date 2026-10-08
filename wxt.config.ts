import path from 'node:path';
import { defineConfig } from 'wxt';

const root = import.meta.dirname;

const EXTENSION_PAGES_CSP =
  "script-src 'self'; object-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:* http://[::1]:*";

/** MV3 takes a policy per page type; Firefox's MV2 build takes one string. */
function extensionCsp(browser: string): string | { extension_pages: string } {
  return browser === 'firefox' ? EXTENSION_PAGES_CSP : { extension_pages: EXTENSION_PAGES_CSP };
}

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
    // M12: the browser, not only the code, keeps the extension's own pages (popup, options, developer audit, where
    // the optional local AI client runs) from connecting anywhere but themselves and the loopback. Scripts stay
    // `'self'` (no eval, no remote code). Content scripts are governed by the page they run in, not by this policy.
    content_security_policy: extensionCsp(browser),
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
