import path from 'node:path';
import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(root, 'src'),
      '@domain': path.resolve(root, 'src/domain'),
      '@core': path.resolve(root, 'src/core'),
      '@infrastructure': path.resolve(root, 'src/infrastructure'),
      '@features': path.resolve(root, 'src/features'),
      '@shared': path.resolve(root, 'src/shared'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    globals: false,
  },
});
