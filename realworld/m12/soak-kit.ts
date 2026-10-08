/**
 * Kit of the M12 resource and soak runs (docs/m12/protocol.md, P24 and P25): the workload page, an OS-level
 * sampler of the browser's process tree. The trend statistics are in stats.ts (pure, unit-tested); the verdict
 * rules live in the protocol, not here.
 */
import { spawnSync } from 'node:child_process';
import { html } from '../lib/scenario';

// ---------------------------------------------------------------------------------------------------------
// OS process tree (Windows)
// ---------------------------------------------------------------------------------------------------------

export interface ProcessSample {
  readonly pid: number;
  readonly role: 'browser' | 'renderer' | 'extension' | 'gpu' | 'utility' | 'crashpad' | 'other';
  /** Working set, bytes. */
  readonly workingSet: number;
  /** Private bytes (commit), bytes. */
  readonly privateBytes: number;
  /** User + kernel CPU time, seconds. */
  readonly cpuSeconds: number;
}

const PS = (profileDir: string): string => `
$ErrorActionPreference = 'SilentlyContinue'
$all = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"
$root = $all | Where-Object { $_.CommandLine -like '*--user-data-dir=*' -and $_.CommandLine -like '*${profileDir.replace(/'/g, "''")}*' -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1
if (-not $root) { '[]'; exit }
$ids = New-Object System.Collections.Generic.HashSet[int]
[void]$ids.Add([int]$root.ProcessId)
do { $n = $ids.Count; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId)) { [void]$ids.Add([int]$p.ProcessId) } } } while ($ids.Count -ne $n)
$all | Where-Object { $ids.Contains([int]$_.ProcessId) } | ForEach-Object {
  [pscustomobject]@{ pid = [int]$_.ProcessId; ws = [int64]$_.WorkingSetSize; priv = [int64]$_.PrivatePageCount; cpu = ([double]$_.UserModeTime + [double]$_.KernelModeTime) / 1e7; cmd = $_.CommandLine }
} | ConvertTo-Json -Compress
`;

function roleOf(cmd: string): ProcessSample['role'] {
  const type = /--type=([\w-]+)/.exec(cmd)?.[1];
  if (!type) return 'browser';
  if (type === 'renderer') return /--extension-process/.test(cmd) ? 'extension' : 'renderer';
  if (type === 'gpu-process') return 'gpu';
  if (type === 'utility') return 'utility';
  if (type === 'crashpad-handler') return 'crashpad';
  return 'other';
}

/** The browser started with `profileDir` and every process below it. Empty when the browser is gone. */
export function sampleProcessTree(profileDir: string): ProcessSample[] {
  const run = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', PS(profileDir)],
    {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const text = run.stdout.trim();
  // an empty answer is "no such browser" only when PowerShell itself ran fine
  if (run.status !== 0) throw new Error(`process sampler failed: ${run.stderr.slice(0, 300)}`);
  if (!text) return [];
  const parsed = JSON.parse(text) as unknown;
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
    pid: number;
    ws: number;
    priv: number;
    cpu: number;
    cmd: string;
  }>;
  return rows.map((r) => ({
    pid: r.pid,
    role: roleOf(r.cmd ?? ''),
    workingSet: r.ws,
    privateBytes: r.priv,
    cpuSeconds: r.cpu,
  }));
}

export const sum = (
  rows: readonly ProcessSample[],
  pick: (p: ProcessSample) => number,
  role?: ProcessSample['role'],
) => rows.filter((r) => role === undefined || r.role === role).reduce((a, r) => a + pick(r), 0);

/** All Chrome-family processes on the host that are not part of any browser we started: user browsers, orphans. */
export function hostBrowserInventory(): { name: string; count: number }[] {
  const run = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-Process | Where-Object { $_.Name -match '^(chrome|brave|msedge|firefox|geckodriver|chromedriver|ollama)$' } | Group-Object Name | ForEach-Object { '{0}={1}' -f $_.Name, $_.Count }",
    ],
    { encoding: 'utf8' },
  );
  return run.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, count] = line.split('=');
      return { name: name ?? '', count: Number(count) };
    });
}

// ---------------------------------------------------------------------------------------------------------
// The workload page
// ---------------------------------------------------------------------------------------------------------

/**
 * A page that behaves like a busy single-page app. `window.workload(i)` performs one bounded cycle of every kind
 * of churn the pipeline has to survive and resolves when it is done. Everything is seeded: cycle i does the same
 * work every run.
 */
export const SOAK_PAGE = html(
  `
  <header><h1>Soak</h1><nav id="nav"></nav></header>
  <main id="view"></main>
  <section id="feed" aria-label="feed"></section>
  <section id="vlist" aria-label="list"></section>
  <section><svg id="chart" width="300" height="80" viewBox="0 0 300 80" role="img" aria-label="series"></svg></section>
  <form id="f" onsubmit="return false">
    <label>Email <input id="email" type="email" required></label>
    <label>Age <input id="age" type="number" min="0" max="120"></label>
    <label>Plan <select id="plan"><option>free</option><option>pro</option></select></label>
  </form>
  <div id="modals"></div>
  <script>
    window.__doc = Math.random().toString(36).slice(2);
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const KINDS = ['cvd', 'low', 'fine'];
    const view = document.getElementById('view');
    const route = (k) => {
      history.pushState({ k }, '', '/' + location.pathname.split('/')[1] + '/r' + k);
      view.innerHTML = '';
      const frag = document.createDocumentFragment();
      for (let i = 0; i < 40; i++) {
        const p = document.createElement(i % 5 === 0 ? 'li' : 'p');
        p.className = KINDS[i % 3];
        p.textContent = 'route ' + k + ' item ' + i;
        if (i % 7 === 0) p.setAttribute('aria-label', 'item ' + i);
        frag.append(p);
      }
      view.append(frag);
    };
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

    async function churn() {
      const host = document.createElement('div');
      for (let i = 0; i < 500; i++) {
        const el = document.createElement(i % 3 === 0 ? 'span' : 'div');
        el.className = pick(KINDS);
        el.textContent = 'n' + i;
        host.append(el);
      }
      document.body.append(host);
      await frame();
      const kids = host.children;
      for (let i = 0; i < 300; i++) {
        const el = kids[Math.floor(rnd() * kids.length)];
        if (!el) continue;
        if (i % 3 === 0) el.className = pick(KINDS);
        else if (i % 3 === 1) el.setAttribute('aria-label', 'x' + i);
        else el.style.opacity = i % 2 ? '0.9' : '1';
      }
      await frame();
      host.remove();
    }

    function chartUpdate() {
      const svg = document.getElementById('chart');
      if (!svg.firstChild) {
        for (let i = 0; i < 60; i++) {
          const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          r.setAttribute('x', String(i * 5)); r.setAttribute('width', '4');
          r.setAttribute('y', '10'); r.setAttribute('height', String(10 + (i % 9) * 6));
          r.setAttribute('fill', '#d62728');
          svg.append(r);
        }
      }
      for (let i = 0; i < 100; i++) svg.children[i % 60].setAttribute('fill', i % 2 ? '#2ca02c' : '#d62728');
    }

    function vlist() {
      const list = document.getElementById('vlist');
      for (let round = 0; round < 5; round++) {
        list.innerHTML = '';
        for (let i = 0; i < 200; i++) {
          const row = document.createElement('div');
          row.className = 'row ' + KINDS[(i + round) % 3];
          row.textContent = 'row ' + (round * 200 + i);
          list.append(row);
        }
      }
    }

    async function modals() {
      const host = document.getElementById('modals');
      const opener = document.querySelector('#nav button');
      for (let i = 0; i < 10; i++) {
        const m = document.createElement('div');
        m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', 'dialog ' + i);
        m.style.cssText = 'position:fixed;inset:20% 20%;background:#fff;color:#aaa;padding:8px';
        m.innerHTML = '<p class="low">Dialog text</p><button type="button">OK</button><input aria-label="field">';
        host.append(m);
        m.querySelector('button').focus();
        await frame();
        m.remove();
        if (opener) opener.focus();
      }
    }

    function feed() {
      const f = document.getElementById('feed');
      for (let i = 0; i < 50; i++) {
        const a = document.createElement('article');
        a.className = KINDS[i % 3];
        a.innerHTML = '<h3>post</h3><p>body text ' + i + '</p>';
        f.append(a);
      }
      while (f.children.length > 300) f.firstChild.remove();
    }

    function forms(i) {
      const email = document.getElementById('email');
      const age = document.getElementById('age');
      email.value = i % 2 ? 'not-an-email' : 'a@b.test';
      email.dispatchEvent(new Event('input', { bubbles: true }));
      age.value = i % 3 ? '500' : '30';
      age.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('f').checkValidity();
    }

    // the nav gives the modal code a control to return focus to
    document.getElementById('nav').innerHTML = '<button type="button">menu</button>';

    window.workload = async (i) => {
      for (let k = 0; k < 20; k++) { route((i * 20 + k) % 50); await tick(5); }
      await churn();
      chartUpdate();
      vlist();
      await modals();
      feed();
      forms(i);
      await tick(50);
      return { doc: window.__doc, nodes: document.getElementsByTagName('*').length };
    };
    route(0);
  </script>`,
);
