import path from 'node:path';
import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;

/**
 * Optional, manual qualification of a live local model runtime (docs/AI_PROVIDER_PROTOCOL.md,
 * "Qualification"): `pnpm qualify:ai` with QUALIFY_ENDPOINT / QUALIFY_PROTOCOL / QUALIFY_MODEL set.
 * Not part of `pnpm test`, `pnpm verify` or `pnpm test:e2e`: nothing else needs a model.
 */
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
    environment: 'node',
    include: ['tests/qualification/**/*.qualify.ts'],
    testTimeout: 3_600_000,
  },
});
