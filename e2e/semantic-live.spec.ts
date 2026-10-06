import { expect, test } from '@playwright/test';
import { launchExtension, startPageServer } from './harness';
import { AUDIT_SETTINGS, loadAudited } from './audit-kit';

/**
 * Optional and manual (docs/AI_PROVIDER_PROTOCOL.md, "Qualification"): the whole flow in Chromium against a
 * real Ollama on this machine. Needs `OLLAMA_ORIGINS` to include `chrome-extension://*` (Ollama refuses an
 * extension's requests with 403 otherwise: the audit then says "Local AI unavailable (http-error)"). Never
 * part of the normal E2E run: set LIVE_OLLAMA=1 (and LIVE_MODEL, default llama3.2:3b) to run it.
 */
test('a real local Ollama, from the audit page of the extension', async () => {
  test.skip(
    process.env['LIVE_OLLAMA'] !== '1',
    'optional: set LIVE_OLLAMA=1 with a running Ollama',
  );
  test.setTimeout(300_000);
  const server = await startPageServer();
  const ext = await launchExtension();
  try {
    const audited = await loadAudited(ext, server, {
      ...AUDIT_SETTINGS,
      semanticAIEnabled: true,
      semanticAIProvider: 'local-ollama',
      semanticAIEndpoint: 'http://127.0.0.1:11434',
      semanticAIModel: process.env['LIVE_MODEL'] ?? 'llama3.2:3b',
    });
    await audited.page.evaluate(() => {
      document.querySelector('#canvas-chart')?.remove();
      document.querySelector('#raster-chart')?.remove();
      const w = document.createElement('div');
      w.innerHTML =
        '<button id="b" type="button"><canvas id="named-chart" class="sales-chart" aria-label="Sales by region" width="300" height="100"></canvas></button>';
      document.querySelector('#audit-fixture')!.append(w);
    });
    const audit = await audited.open();
    await audit.getByTestId('assist-run').click();
    await expect(audit.getByTestId('assist-stats')).toBeVisible({ timeout: 240_000 });
    const text = await audit.getByTestId('assist-stats').innerText();
    const coverage = await audit.getByTestId('assist-coverage').getAttribute('data-coverage');
    const badges = await audit.getByTestId('assist-badge').allInnerTexts();
    process.stdout.write(`LIVE ${JSON.stringify({ coverage, text, badges })}\n`);
  } finally {
    await ext.close();
    await server.close();
  }
});
