import path from 'node:path';
import { defineConfig } from 'wxt';

const root = import.meta.dirname;

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  outDir: 'dist',
  manifest: {
    name: 'ColorAdapt',
    description:
      'Adapts web pages for people with color vision deficiencies by detecting and fixing hard-to-distinguish color combinations.',
    permissions: ['storage'],
    host_permissions: ['http://*/*', 'https://*/*'],
  },
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
