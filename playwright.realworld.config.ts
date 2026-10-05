import { defineConfig } from '@playwright/test';

/**
 * M10 real-world validation (docs/REAL_WORLD_VALIDATION.md). Not part of `pnpm test:e2e`: these specs drive the
 * installed Chrome and Firefox against the live web and local hostile fixtures, are slow, and the live part
 * depends on the network. Run with `pnpm test:realworld` after `pnpm build` and `pnpm build:firefox`.
 */
export default defineConfig({
  testDir: 'realworld',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list']],
  timeout: 240_000,
  expect: { timeout: 15_000 },
});
