/**
 * Shared kit of the M12.5 burst-scalability suites (docs/m125/protocol.md): the burst fixtures (corpus A to G),
 * the in-page instruments (input-delay probe, long-task recorder) and the reading of a burst. Everything runs
 * against the production builds in the real browsers; the only thing the page knows about ColorAdapt is nothing.
 */
import type { Driver, Tab } from '../lib/driver';
import { ChromeTab } from '../lib/driver';
import { html, until } from '../lib/scenario';
import { gauges, quiesce } from '../m12/kit';

/** The pre-frozen slice vocabulary (docs/PERFORMANCE.md "Burst model"). */
export interface SliceGauges {
  readonly slices: number;
  readonly maxSliceMs: number;
  readonly totalSliceMs: number;
  readonly peakQueuedRecords: number;
  readonly peakDeferredRoots: number;
  readonly staleRoots: number;
  readonly cancelledRoots: number;
  readonly incrementalPasses: number;
  readonly fullRescans: number;
  readonly truncatedPasses: number;
  readonly elementsProcessed: number;
}

export const sliceGauges = (tab: Tab): Promise<SliceGauges> =>
  tab.ext<SliceGauges>('GET_DYNAMIC_DIAGNOSTICS');

type BurstKind = 'text' | 'mixed' | 'nested' | 'svg' | 'semantic' | 'rows' | 'inline' | 'chart';

const SEMANTIC_CSS = `
  .badge { display: inline-block; padding: 2px 6px; color: #ffffff; background-color: #7f8c8d; }
  .badge.success { background-color: #1e8449; }
  .badge.error { background-color: #c0392b; }
  .status { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
  .status.online { background-color: #27ae60; }
  .status.offline { background-color: #c0392b; }
  .bgA { background-color: #27ae60; } .bgB { background-color: #fff3e0; } .bgC { background-color: #e8eaf6; }
  .redA { color: #c0392b; } .grayB { color: #bbbbbb; } .blueC { color: #3f51b5; }
`;

/**
 * The page every burst runs on: 300 paragraphs (so the extension has a stylesheet before the burst), the burst
 * generators, the input-delay probe and a long-task recorder. `__b.insert` does the whole insertion in ONE task
 * and returns `performance.now()` at its end, so everything that happens later is not the page's own script.
 */
export function burstPage(): string {
  const base = Array.from(
    { length: 300 },
    (_v, i) => `<p class="${['cvd', 'low', 'fine'][i % 3]}">paragraph ${i}</p>`,
  ).join('');
  return html(
    `<button id="probe" type="button">probe</button><div id="root">${base}</div><div id="burst"></div>
    <script>
      const classes = ['cvd', 'low', 'fine'];
      const make = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; e.textContent = text; return e; };
      const lineChart = (i) => {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 400 300'); svg.setAttribute('width', '400'); svg.setAttribute('height', '300');
        const colors = ['#1f77b4', '#ff7f0e', '#2ca02c'];
        const axis = document.createElementNS(ns, 'path'); axis.setAttribute('d', 'M40 260 H380'); axis.setAttribute('stroke', '#888'); axis.setAttribute('fill', 'none'); svg.append(axis);
        colors.forEach((c, k) => {
          const p = document.createElementNS(ns, 'path');
          p.setAttribute('class', 'line'); p.setAttribute('fill', 'none'); p.setAttribute('stroke', c); p.setAttribute('stroke-width', '2');
          p.setAttribute('d', 'M60 ' + (100 + k * 10) + ' L100 ' + (120 + k * 5) + ' L140 ' + (90 + k * 8) + ' L180 ' + (130 - k * 4) + ' L220 ' + (80 + k * 12) + ' L260 ' + (110 + k * 3));
          svg.append(p);
          const g = document.createElementNS(ns, 'g');
          const l = document.createElementNS(ns, 'line'); l.setAttribute('x1', '300'); l.setAttribute('y1', String(15 + k * 16)); l.setAttribute('x2', '320'); l.setAttribute('y2', String(15 + k * 16)); l.setAttribute('stroke', c); l.setAttribute('stroke-width', '2');
          const t = document.createElementNS(ns, 'text'); t.setAttribute('x', '325'); t.setAttribute('y', String(20 + k * 16)); t.setAttribute('fill', '#222'); t.textContent = 'Series ' + (k + 1) + ' of ' + i;
          g.append(l, t); svg.append(g);
        });
        return svg;
      };
      const row = {
        text: (i) => make('p', classes[i % 3], 'm' + i),
        mixed: (i) => make(['span', 'div', 'time', 'code', 'em', 'strong', 'small', 'a', 'label', 'li'][i % 10], classes[(i >> 1) % 3], 'm' + i),
        nested: (i) => { const a = make('div', ['bgB', 'bgB', 'bgC'][i % 3], ''); const b = make('div', ['bgA', '', 'bgC'][i % 3], ''); b.append(make('p', ['redA', 'grayB', 'blueC'][i % 3], 'n' + i)); a.append(b); return a; },
        svg: (i) => { const s = make('span', classes[i % 3], ''); s.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M0 0h16v16H0z" fill="currentColor"/></svg>'; return s; },
        semantic: (i) => { const r = make('div', 'row', ''); r.append(make('span', i % 2 ? 'badge success' : 'badge error', 'order ' + i), make('span', i % 2 ? 'status online' : 'status offline', '')); return r; },
        rows: (i) => { const r = make('div', 'row', ''); r.append(make('span', i % 2 ? 'badge success' : 'badge error', 'order ' + i), make('span', i % 2 ? 'status online' : 'status offline', ''), make('span', 'cvd', 'note ' + i)); return r; },
        inline: (i) => make('span', i % 4 === 0 ? 'badge success' : i % 4 === 1 ? 'badge error' : i % 4 === 2 ? 'status online' : 'status offline', i % 4 < 2 ? 'order ' + i : ''),
        chart: (i) => { const d = make('div', '', ''); d.append(lineChart(i)); return d; },
      };
      window.__b = {
        per: { text: 100, mixed: 100, nested: 50, svg: 50, semantic: 25, rows: 25, inline: 100, chart: 5 },
        insert(kind, n) {
          const root = document.getElementById('burst');
          const per = this.per[kind];
          for (let r = 0; r < n / per; r++) {
            const host = document.createElement('div');
            for (let i = 0; i < per; i++) host.append(row[kind](r * per + i));
            root.append(host);
          }
          return performance.now();
        },
        // the same elements, directly under one parent (the full-rescan path)
        insertFlat(kind, n) { const root = document.getElementById('burst'); for (let i = 0; i < n; i++) root.append(row[kind](i)); return performance.now(); },
        // one container with all of them (a single oversized region)
        insertOne(kind, n) { const root = document.getElementById('burst'); const host = document.createElement('div'); for (let i = 0; i < n; i++) host.append(row[kind](i)); root.append(host); return performance.now(); },
        // a stream: perFrame elements every animation frame for ms milliseconds
        stream(kind, perFrame, ms) {
          return new Promise((resolve) => {
            const root = document.getElementById('burst'); const t0 = performance.now(); let added = 0;
            const step = () => {
              const host = document.createElement('div');
              for (let i = 0; i < perFrame; i++) host.append(row[kind](added + i));
              added += perFrame; root.append(host);
              if (performance.now() - t0 < ms) requestAnimationFrame(step); else resolve(added);
            };
            requestAnimationFrame(step);
          });
        },
        // virtualized list: every frame, remove the window and insert the next one in the same place
        churn(kind, windowSize, frames) {
          return new Promise((resolve) => {
            const root = document.getElementById('burst'); let f = 0;
            const step = () => {
              root.replaceChildren();
              for (let i = 0; i < windowSize; i++) root.append(row[kind](f * windowSize + i));
              f += 1;
              if (f < frames) requestAnimationFrame(step); else resolve(f);
            };
            requestAnimationFrame(step);
          });
        },
        clear() { document.getElementById('burst').replaceChildren(); },
        delays: [],
        // animation-frame gaps of the page: every gap is a stretch in which the page could not render
        frames: { max: 0, count: 0, last: 0, running: false },
        trackFrames() { const f = this.frames; f.max = 0; f.count = 0; f.last = performance.now(); f.running = true; const tick = (t) => { f.max = Math.max(f.max, t - f.last); f.last = t; f.count += 1; if (f.running) requestAnimationFrame(tick); }; requestAnimationFrame(tick); },
        stopFrames() { this.frames.running = false; return { max: Math.round(this.frames.max), count: this.frames.count }; },
      };
      document.getElementById('probe').addEventListener('click', (e) => { window.__b.delays.push(performance.now() - e.timeStamp); });
      window.__lt = [];
      // The browser reports long tasks only while the page is producing frames: keep one frame request pending.
      const keepAlive = () => requestAnimationFrame(keepAlive); requestAnimationFrame(keepAlive);
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]); }).observe({ entryTypes: ['longtask'] }); } catch (e) { window.__ltUnavailable = true; }
    </script>`,
    `<style>${SEMANTIC_CSS}</style>`,
  );
}

export const FIXTURE = 'burst';

/**
 * A compact digest of what the page ended with, comparable across builds: for every element of the burst its computed
 * color, background color and semantic cue, folded into a rolling hash, plus how many elements are styled.
 */
export const FINAL_DIGEST = `(() => {
  const nodes = document.querySelectorAll('#burst *');
  let h = 2166136261 >>> 0; let adapted = 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const s = getComputedStyle(n).color + '|' + getComputedStyle(n).backgroundColor + '|' + (n.getAttribute('data-coloradapt-cue') || '');
    for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 16777619) >>> 0; }
    if (n.hasAttribute('data-coloradapt-s')) adapted++;
  }
  const tokens = new Set();
  for (const n of document.querySelectorAll('#burst [data-coloradapt-s]')) for (const t of n.getAttribute('data-coloradapt-s').split(' ')) if (t) tokens.add(t);
  return { elements: nodes.length, adapted, hash: h.toString(16), tokens: [...tokens].sort() };
})()`;

interface Digest {
  readonly elements: number;
  readonly adapted: number;
  readonly hash: string;
  /** The distinct declarations (`data-coloradapt-s` tokens) the burst's elements are subject to. */
  readonly tokens: string[];
}

export interface BurstReading {
  readonly kind: string;
  readonly shape: string;
  readonly n: number;
  readonly toIdleMs: number;
  readonly throughput: number;
  readonly ownedLongestMs: number | null;
  readonly ownedLongTasks: number | null;
  readonly gauges: SliceGauges;
  readonly rules: number;
  readonly digest: Digest;
}

export interface Burst {
  readonly kind: BurstKind;
  readonly n: number;
  readonly shape?: 'hosts' | 'flat' | 'one';
}

const METHOD = { hosts: 'insert', flat: 'insertFlat', one: 'insertOne' } as const;

/** Opens the burst page in a fresh tab and waits until the extension has adapted it and is quiet. */
export async function openBurstTab(
  driver: Driver,
  origin: string,
  extension: boolean,
  query = '',
): Promise<Tab> {
  const tab = await driver.newTab();
  await tab.open(`${origin}/${FIXTURE}${query}`);
  if (extension) {
    await until(
      () => tab.evaluate<boolean>(`!!document.getElementById('coloradapt-stylesheet')`),
      'adapted',
    );
    await quiesce(tab);
  }
  return tab;
}

/** Long tasks that started after the page's own insertion task ended (Chromium only; otherwise null). */
async function ownedLongTasks(
  tab: Tab,
  insertedAt: number,
): Promise<{ longest: number; count: number } | null> {
  if (!(tab instanceof ChromeTab)) return null;
  const unavailable = await tab.evaluate<boolean>(`!!window.__ltUnavailable`);
  if (unavailable) return null;
  const entries = await tab.evaluate<number[][]>(
    `window.__lt.filter((e) => e[0] >= ${insertedAt})`,
  );
  return { longest: Math.round(Math.max(0, ...entries.map((e) => e[1]!))), count: entries.length };
}

/**
 * One burst on a fresh page: insertion in one page task, then the time until the pipeline is quiet again.
 * `extension: false` is the control (the same page work and the browser's own rendering, no ColorAdapt).
 */
export async function runBurst(
  driver: Driver,
  origin: string,
  burst: Burst,
  extension = true,
): Promise<BurstReading> {
  const shape = burst.shape ?? 'hosts';
  const tab = await openBurstTab(driver, origin, extension);
  try {
    const start = Date.now();
    const insertedAt = await tab.evaluate<number>(
      `window.__b.${METHOD[shape]}(${JSON.stringify(burst.kind)}, ${burst.n})`,
    );
    let g: SliceGauges = emptyGauges();
    let rules = 0;
    if (extension) {
      await until(
        async () => (await gauges(tab)).state === 'IDLE',
        `idle after ${burst.n} ${burst.kind}`,
        240_000,
      );
      const q = await quiesce(tab);
      rules = q.rules;
      g = await sliceGauges(tab);
    } else {
      await tab.evaluate(
        `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`,
      );
    }
    const toIdleMs = Date.now() - start;
    const owned = await ownedLongTasks(tab, insertedAt);
    const digest = await tab.evaluate<Digest>(FINAL_DIGEST);
    return {
      kind: burst.kind,
      shape,
      n: burst.n,
      toIdleMs,
      throughput: Math.round(burst.n / (toIdleMs / 1000)),
      ownedLongestMs: owned?.longest ?? null,
      ownedLongTasks: owned?.count ?? null,
      gauges: g,
      rules,
      digest,
    };
  } finally {
    await tab.close();
  }
}

const emptyGauges = (): SliceGauges => ({
  slices: 0,
  maxSliceMs: 0,
  totalSliceMs: 0,
  peakQueuedRecords: 0,
  peakDeferredRoots: 0,
  staleRoots: 0,
  cancelledRoots: 0,
  incrementalPasses: 0,
  fullRescans: 0,
  truncatedPasses: 0,
  elementsProcessed: 0,
});

/** Input delay probe: real clicks on the page's button while it is busy; the page records the delay of each. */
export async function clickProbe(tab: Tab, times: number, gapMs: number): Promise<number[]> {
  await tab.evaluate(`(window.__b.delays.length = 0, 1)`);
  for (let i = 0; i < times; i++) {
    await tab.click('#probe');
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return await tab.evaluate<number[]>(`window.__b.delays.slice()`);
}

export const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
};
