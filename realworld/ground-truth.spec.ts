/**
 * Tier A ground truth for the contrast comparison (M10.R1): what the *browser actually paints*, read from a
 * screenshot, against (a) the independent oracle and (b) the product's own decision (the injected trace).
 *
 * Each fixture is a huge bold "I" on a known background. The background pixel and the glyph's solid core are
 * read from the screenshot; the ratio of those two 8-bit colors is the ground truth. Neither the oracle nor
 * ColorAdapt is consulted for it. The fixtures are the families the real-world comparison found (color
 * functions the oracle could not read, opacity groups, display: contents, text fill, ...).
 */
import { test, expect } from '@playwright/test';
import { contrastRatio } from './lib/color';
import { decodePng } from './lib/png';
import { call, oracleProbe, type OracleElement } from './lib/probe';
import { oracleRows, traceElements } from './lib/page-run';
import { BROWSERS, launch, record } from './lib/scenario';
import { startFixtureServer } from './lib/server';

interface Fixture {
  readonly id: string;
  /** The text element is `#t`; `open`/`close` wrap it. */
  readonly open?: string;
  readonly close?: string;
  readonly style: string;
  /** Style of the `<html>` element (a `color-scheme`, a canvas background). */
  readonly htmlStyle?: string;
  /** What the product (and the oracle) must say: a ratio near the pixels', or "unresolved". */
  readonly expect: 'ratio' | 'unresolved' | 'not-painted';
  /** Known to differ in one browser (rendering difference, not a defect). */
  readonly skip?: string;
}

const FIXTURES: Fixture[] = [
  { id: 'plain', style: 'color:#767676;background:#ffffff', expect: 'ratio' },
  { id: 'gray-on-white-fail', style: 'color:#999999;background:#ffffff', expect: 'ratio' },
  { id: 'rgba-background', style: 'color:#ffffff;background:rgba(0,0,0,0.5)', expect: 'ratio' },
  { id: 'rgba-foreground', style: 'color:rgba(0,0,0,0.5);background:#ffffff', expect: 'ratio' },
  {
    id: 'opacity-group',
    open: '<div style="opacity:0.5;background:#000000">',
    close: '</div>',
    style: 'color:#ffffff',
    expect: 'ratio',
  },
  {
    id: 'nested-opacity',
    open: '<div style="opacity:0.5;background:#000000"><div style="opacity:0.5;background:#000000">',
    close: '</div></div>',
    style: 'color:#ffffff',
    expect: 'ratio',
  },
  {
    id: 'own-opacity-with-background',
    style: 'color:#000000;background:#ffffff;opacity:0.6',
    expect: 'ratio',
  },
  {
    id: 'transparent-ancestors',
    open: '<div style="background:#203040"><div><section>',
    close: '</section></div></div>',
    style: 'color:#e0e8f0',
    expect: 'ratio',
  },
  {
    id: 'color-mix-background',
    style: 'color:#ffffff;background:color-mix(in srgb, #000000 50%, #ffffff)',
    expect: 'ratio',
  },
  { id: 'oklch-background', style: 'color:#ffffff;background:oklch(0.3 0.1 250)', expect: 'ratio' },
  {
    id: 'display-p3-background',
    style: 'color:#ffffff;background:color(display-p3 0 0.2 0.8)',
    expect: 'ratio',
  },
  { id: 'lab-foreground', style: 'color:lab(30 20 20);background:#ffffff', expect: 'ratio' },
  {
    id: 'display-contents',
    open: '<div style="background:#202020;font:bold 220px/1 Arial,Helvetica,sans-serif;width:400px;height:240px">',
    close: '</div>',
    style: 'display:contents;color:#e0e0e0',
    expect: 'ratio',
  },
  {
    id: 'text-fill-color',
    style: 'color:#000000;-webkit-text-fill-color:#767676;background:#ffffff',
    expect: 'ratio',
  },
  {
    id: 'dark-canvas-transparent',
    htmlStyle: 'color-scheme:dark',
    style: 'color:#999999',
    expect: 'ratio',
  },
  {
    id: 'light-dark-scheme-follows-preference',
    htmlStyle: 'color-scheme:light dark',
    style: 'color:#6a7282',
    expect: 'ratio',
  },
  {
    id: 'html-background-over-dark-scheme',
    htmlStyle: 'color-scheme:dark;background:#f0f0f0',
    style: 'color:#6a7282',
    expect: 'ratio',
  },
  {
    id: 'opaque-background-covers-a-gradient',
    open: '<div style="background-image:linear-gradient(#ffffff,#eeeeee)">',
    close: '</div>',
    style: 'color:#767676;background:#ffffff',
    expect: 'ratio',
  },
  {
    id: 'opaque-background-in-a-faded-ancestor-over-a-gradient',
    open: '<div style="background-image:linear-gradient(#ffffff,#eeeeee)"><div style="opacity:0.36">',
    close: '</div></div>',
    style: 'color:#767676;background:#ffffff',
    expect: 'unresolved',
  },
  {
    id: 'scaled-to-zero',
    open: '<div style="transform:scale(0)">',
    close: '</div>',
    style: 'color:#999999;background:#ffffff',
    expect: 'not-painted',
  },
  {
    id: 'gradient-background',
    style: 'color:#999999;background-image:linear-gradient(#ffffff,#eeeeee)',
    expect: 'unresolved',
  },
  {
    id: 'color-filter-ancestor',
    open: '<div style="filter:grayscale(1);background:#ffffff">',
    close: '</div>',
    style: 'color:#999999',
    expect: 'unresolved',
  },
];

const page = (
  f: Fixture,
): string => `<!doctype html><html style="${f.htmlStyle ?? ''}"><meta charset="utf-8"><title>${f.id}</title>
<body style="margin:0;${f.htmlStyle ? '' : 'background:#ffffff'}">${f.open ?? ''}<div id="t" style="font:bold 220px/1 Arial,Helvetica,sans-serif;width:400px;height:240px;${f.style}">I</div>${f.close ?? ''}</body>`;

test.describe.configure({ mode: 'serial' });

for (const browser of BROWSERS) {
  test(`ground truth: pixels vs oracle vs product (${browser})`, async () => {
    const server = await startFixtureServer();
    const driver = await launch(browser);
    const failures: string[] = [];
    try {
      for (const f of FIXTURES) {
        server.serve(`gt-${f.id}.html`, page(f));
        const tab = await driver.newTab();
        try {
          await tab.open(`${server.origin}/gt-${f.id}.html`);
          await new Promise((r) => setTimeout(r, 400));
          const probe = await tab.evaluate<{ elements: OracleElement[] }>(call(oracleProbe, 50));
          const row = oracleRows(probe.elements, driver.name).find((r) => r.path === '#t');
          if (!row) throw new Error('no oracle row for #t');
          const traces = await traceElements(tab, [row.full]);
          const trace = traces[row.full]?.now ?? null;
          const shot = decodePng(await tab.screenshot());
          // region of the fixture: top-left 400 x 240 (device pixels = CSS pixels in these browsers' default)
          const at = (x: number, y: number): [number, number, number] => {
            const i = (y * shot.width + x) * 4;
            return [shot.data[i]!, shot.data[i + 1]!, shot.data[i + 2]!];
          };
          const bg = at(395, 235);
          const dist = (a: number[], b: number[]) =>
            (a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2;
          let best = bg;
          let bestDistance = 0;
          for (let y = 0; y < 240; y += 2) {
            for (let x = 0; x < 400; x += 2) {
              const px = at(x, y);
              const d = dist(px, bg);
              if (d > bestDistance) {
                bestDistance = d;
                best = px;
              }
            }
          }
          const pixelRatio = contrastRatio(
            { r: best[0], g: best[1], b: best[2], a: 1 },
            { r: bg[0], g: bg[1], b: bg[2], a: 1 },
          );
          const detail = `pixels ${best.join(',')}/${bg.join(',')} = ${pixelRatio.toFixed(3)}; oracle ${row.status} ${row.ratio}; product ${trace?.reason} ${trace?.ratio}`;
          if (f.expect === 'not-painted') {
            const ok = trace?.reason === 'SKIP_NOT_RENDERED' && row.flags.includes('hidden:');
            record(
              driver,
              'ground-truth',
              f.id,
              ok ? 'PASS' : 'FAIL',
              `oracle ${row.flags}; product ${trace?.reason}`,
            );
            if (!ok)
              failures.push(
                `${f.id}: expected not painted. oracle ${row.flags}; product ${trace?.reason}`,
              );
            continue;
          }
          if (f.expect === 'unresolved') {
            const ok = row.status !== 'RESOLVED' && trace !== null && trace.ratio === null;
            record(driver, 'ground-truth', f.id, ok ? 'PASS' : 'FAIL', detail);
            if (!ok) failures.push(`${f.id}: expected unresolved. ${detail}`);
            continue;
          }
          const near = (value: number | null) =>
            value !== null && Math.abs(value - pixelRatio) / pixelRatio <= 0.04;
          const oracleOk = row.status === 'RESOLVED' && near(row.ratio);
          const productOk = trace !== null && near(trace.ratio);
          record(driver, 'ground-truth', f.id, oracleOk && productOk ? 'PASS' : 'FAIL', detail);
          if (!oracleOk) failures.push(`${f.id} ORACLE: ${detail}`);
          if (!productOk) failures.push(`${f.id} PRODUCT: ${detail}`);
        } finally {
          await tab.close();
        }
      }
    } finally {
      await driver.close();
      await server.close();
    }
    expect(failures).toEqual([]);
  });
}
