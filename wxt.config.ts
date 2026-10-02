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
  vite: () => ({
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
