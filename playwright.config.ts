import { defineConfig } from '@playwright/test';

/**
 * Real-browser E2E (docs/DEVELOPMENT.md "Real-browser E2E"). Runs the built
 * extension (`dist/chrome-mv3-e2e`, run `pnpm build:e2e` first or use `pnpm test:e2e`)
 * in Chromium. Serial on purpose: one persistent browser context, and no test
 * may depend on wall-clock timing.
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
});
