/**
 * CPU profile of the 10,000-mutation burst (Chrome, DevTools profiler). Needs the unminified build:
 * `npx wxt build -c wxt.profile.config.ts` (writes `dist-profile/`), then `RW_PROFILE=1 pnpm test:realworld profile-dynamic`.
 * Prints self and inclusive time per function; used to find where the dynamic pipeline spends a burst (docs/REAL_WORLD_VALIDATION.md).
 */
import { test } from '@playwright/test';
import path from 'node:path';
import { ROOT, startChrome } from './lib/driver';
import { startFixtureServer } from './lib/server';
import { SETTINGS_ON, html, until } from './lib/scenario';
import { isChrome } from './lib/metrics';

const PAGE = html(`<ul id="list"></ul><script>
  window.burst = async (n) => { const list = document.getElementById('list'); let i = 0;
    while (i < n) { for (let k = 0; k < 100 && i < n; k++, i++) { const li = document.createElement('li'); li.id = 'r' + i; li.className = i % 10 === 0 ? 'low' : i % 7 === 0 ? 'cvd' : 'fine'; li.textContent = 'row ' + i; list.appendChild(li); }
      await new Promise((r) => requestAnimationFrame(r)); } };
</script>`);

test('profile', async () => {
  test.skip(process.env['RW_PROFILE'] !== '1', 'set RW_PROFILE=1 (needs dist-profile)');
  const server = await startFixtureServer();
  server.serve('dyn', PAGE);
  const driver = await startChrome({
    extensionDir: path.join(ROOT, 'dist-profile', 'chrome-mv3'),
  });
  await driver.setSettings(SETTINGS_ON);
  const tab = await driver.newTab();
  await tab.open(`${server.origin}/dyn`);
  await until(() => tab.ext('GET_DYNAMIC_DIAGNOSTICS'), 'cs');
  await tab.ext('ENABLE_ADAPTATION');
  if (!isChrome(tab)) throw new Error('chrome only');
  const cdp = await tab.session();
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 250 });
  await cdp.send('Profiler.start');
  await tab.evaluate('window.burst(10000)');
  await until(
    async () => (await tab.ext<{ state: string }>('GET_DYNAMIC_DIAGNOSTICS')).state === 'IDLE',
    'idle',
    120000,
  );
  const { profile } = (await cdp.send('Profiler.stop')) as {
    profile: {
      nodes: Array<{
        id: number;
        callFrame: { functionName: string; url: string; lineNumber: number };
        children?: number[];
      }>;
      samples: number[];
      timeDeltas: number[];
    };
  };
  const self = new Map<number, number>();
  profile.samples.forEach((id, i) =>
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)),
  );
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const selfByFn = new Map<string, number>();
  const inclusive = new Map<string, number>();
  for (const [id, t] of self) {
    const n = byId.get(id)!;
    const key = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`;
    selfByFn.set(key, (selfByFn.get(key) ?? 0) + t);
    const seen = new Set<string>();
    for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
      const c = byId.get(cur)!;
      const k = `${c.callFrame.functionName || '(anon)'} ${c.callFrame.url.split('/').pop()}:${c.callFrame.lineNumber}`;
      if (!seen.has(k)) {
        seen.add(k);
        inclusive.set(k, (inclusive.get(k) ?? 0) + t);
      }
    }
  }
  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => `${(v / 1000).toFixed(0).padStart(6)} ms  ${k}`);
  console.log('SELF\n' + top(selfByFn, 18).join('\n'));
  console.log('INCLUSIVE\n' + top(inclusive, 30).join('\n'));
  await driver.close();
  await server.close();
});
