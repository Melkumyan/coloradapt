/**
 * What ColorAdapt really does with each kind of content, in both real browsers, and whether the developer
 * audit's coverage says so honestly: Shadow DOM (open, nested, closed), inline SVG, canvas, raster images,
 * charts, iframes (same-origin, cross-origin, nested). Each check records SUPPORTED / PARTIAL / UNSUPPORTED as
 * observed; the assertions are on facts (the page is not damaged, nothing outside the supported area changed,
 * the coverage never claims more than what happened), not on what would be nice.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AuditSnapshot } from '../src/core/audit';
import { ROOT, type Driver, type Tab } from './lib/driver';
import { discPng, solidPng, startFixtureServer, textPng, type FixtureServer } from './lib/server';
import {
  BROWSERS,
  SETTINGS_ON,
  affected,
  auditRun,
  coverageLevel,
  hasStylesheet,
  html,
  launch,
  record,
  settled,
  sleep,
  until,
} from './lib/scenario';

const AREA = 'features';
const PAGES = path.join(ROOT, 'e2e', 'pages');

/** Computed color of an element inside any (open) shadow root path, e.g. `#host >>> p`. */
const deepColor = (selector: string, property = 'color') =>
  `(() => { const parts = ${JSON.stringify(selector)}.split(' >>> '); let root = document; let el = null; for (const part of parts) { el = root.querySelector(part); if (!el) return 'missing'; root = el.shadowRoot || el; } return getComputedStyle(el).getPropertyValue(${JSON.stringify(property)}); })()`;

for (const browser of BROWSERS) {
  test.describe(`features ${browser}`, () => {
    test.describe.configure({ mode: 'serial' });
    let driver: Driver;
    let server: FixtureServer;

    test.beforeAll(async () => {
      server = await startFixtureServer();
      driver = await launch(browser);
      await driver.setSettings(SETTINGS_ON);
    });
    test.afterAll(async () => {
      await driver?.close();
      await server?.close();
    });

    const openPage = async (
      name: string,
      body: string,
      settings: Record<string, unknown> = SETTINGS_ON,
    ): Promise<Tab> => {
      await driver.setSettings(settings);
      server.serve(name, body);
      const tab = await driver.newTab();
      await tab.open(`${server.origin}/${name}`);
      await until(() => tab.ext('GET_DYNAMIC_DIAGNOSTICS'), 'content script');
      if (settings['enabled'] === true) {
        await tab.ext('ENABLE_ADAPTATION');
        await settled(tab);
      }
      return tab;
    };

    test('Shadow DOM: open, nested, closed, slotted', async () => {
      const tab = await openPage(
        'shadow',
        html(`
        <div id="host-open"></div><div id="host-nested"></div><div id="host-closed"></div>
        <div id="host-slot"><span id="slotted" class="cvd">slotted light-DOM text, red on green</span></div>
        <p id="light" class="cvd">light DOM text, red on green</p>
        <script>
          const row = (id) => '<p id="' + id + '-cvd" style="color:#d62728;background:#2ca02c">shadow text red on green</p><p id="' + id + '-low" style="color:#aaaaaa;background:#ffffff">shadow low contrast</p>';
          document.getElementById('host-open').attachShadow({ mode: 'open' }).innerHTML = row('o');
          const outer = document.getElementById('host-nested').attachShadow({ mode: 'open' });
          outer.innerHTML = '<div id="inner-host"></div>';
          outer.getElementById('inner-host').attachShadow({ mode: 'open' }).innerHTML = row('n');
          window.__closed = document.getElementById('host-closed').attachShadow({ mode: 'closed' });
          window.__closed.innerHTML = row('c');
          document.getElementById('host-slot').attachShadow({ mode: 'open' }).innerHTML = '<slot></slot>';
        </script>`),
      );
      const RED = 'rgb(214, 39, 40)';
      const light = await tab.evaluate<string>(deepColor('#light'));
      const slotted = await tab.evaluate<string>(deepColor('#slotted'));
      const open = await tab.evaluate<string>(deepColor('#host-open >>> #o-cvd'));
      const nested = await tab.evaluate<string>(
        deepColor('#host-nested >>> #inner-host >>> #n-cvd'),
      );
      const closed = await tab.evaluate<string>(
        'getComputedStyle(window.__closed.getElementById("c-cvd")).color',
      );
      const snap = await auditRun(tab);
      const level = coverageLevel(snap, 'shadow-dom');
      const adapted = (c: string) => c !== RED;
      expect(adapted(light)).toBe(true); // the light-DOM control proves adaptation ran
      const verdict = (changed: boolean) => (changed ? 'SUPPORTED' : 'UNSUPPORTED');
      const detail = `adapted? light:${adapted(light)} slotted:${adapted(slotted)} open:${adapted(open)} nested:${adapted(nested)} closed:${adapted(closed)}; audit shadow-dom coverage: ${level}; audit saw shadow elements: ${
        affected(snap, 'CA-COLOR-001')
          .concat(affected(snap, 'CA-COLOR-002'))
          .filter((p) => /^#(o|n|c)-/.test(p)).length
      }`;
      // honesty: whatever the engine did, the audit never claims to have covered a shadow tree it did not look into
      expect(['unsupported', 'partial']).toContain(level);
      const seen = affected(snap, 'CA-COLOR-001')
        .concat(affected(snap, 'CA-COLOR-002'))
        .filter((p) => /^#(o|n|c)-/.test(p));
      expect(seen).toEqual([]);
      record(
        driver,
        AREA,
        'shadow DOM: slotted light-DOM content',
        verdict(adapted(slotted)) === 'SUPPORTED' ? 'PASS' : 'INFO',
        `slotted ${verdict(adapted(slotted))}; ${detail}`,
      );
      record(driver, AREA, 'shadow DOM: open root', 'INFO', `${verdict(adapted(open))}; ${detail}`);
      record(
        driver,
        AREA,
        'shadow DOM: nested open root',
        'INFO',
        `${verdict(adapted(nested))}; ${detail}`,
      );
      record(
        driver,
        AREA,
        'shadow DOM: closed root',
        'INFO',
        `${verdict(adapted(closed))}; ${detail}`,
      );
      await tab.close();
    });

    test('SVG: inline fill/stroke/currentColor/multicolor/text, <use>, and SVG as an image', async () => {
      server.serveRaw(
        'icon.svg',
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M2 2 L22 2 L12 22 Z" fill="#d62728"/></svg>',
        'image/svg+xml',
      );
      const tab = await openPage(
        'svg',
        html(`
        <svg id="fill" width="24" height="24" viewBox="0 0 24 24" role="img" aria-label="warn"><path d="M2 2 L22 2 L12 22 Z" fill="#dddddd"/></svg>
        <svg id="stroke" width="24" height="24" viewBox="0 0 24 24" role="img" aria-label="line"><path d="M2 12 L22 12" stroke="#dddddd" stroke-width="3" fill="none"/></svg>
        <button type="button" style="color:#dddddd;background:#ffffff"><svg id="current" width="24" height="24" viewBox="0 0 24 24" role="img" aria-label="menu"><path d="M2 4 H22 M2 12 H22" stroke="currentColor" stroke-width="3"/></svg></button>
        <svg id="multi" width="48" height="24" viewBox="0 0 48 24" role="img" aria-label="two"><rect x="0" y="0" width="22" height="24" fill="#d62728"/><rect x="26" y="0" width="22" height="24" fill="#2ca02c"/></svg>
        <svg id="text" width="200" height="30" role="img" aria-label="t"><rect width="200" height="30" fill="#ffffff"/><text id="svgtext" x="4" y="20" fill="#cccccc">svg text low contrast</text></svg>
        <svg width="0" height="0"><symbol id="sym" viewBox="0 0 24 24"><path d="M2 2 L22 2 L12 22 Z" fill="#dddddd"/></symbol></svg>
        <svg id="useicon" width="24" height="24" role="img" aria-label="use"><use href="#sym"/></svg>
        <img id="svgimg" src="/icon.svg" alt="warning" width="24" height="24">`),
      );
      const snap = await auditRun(tab);
      const svgFindings = snap.findings
        .filter((f) => f.ruleId.startsWith('CA-SVG'))
        .map((f) => `${f.ruleId}:${f.assessment}:${f.affectedCount}`);
      const level = coverageLevel(snap, 'svg');
      const changed = await tab.evaluate<Record<string, string>>(
        `(() => { const g = (id, p) => getComputedStyle(document.querySelector(id)).getPropertyValue(p); return { fill: g('#fill path','fill'), stroke: g('#stroke path','stroke'), current: g('#current path','stroke'), multiA: g('#multi rect:first-child','fill'), text: g('#svgtext','fill') }; })()`,
      );
      expect(
        await tab.evaluate<boolean>(
          `document.getElementById('fill').getAttribute('role') === 'img' && document.getElementById('fill').getAttribute('aria-label') === 'warn'`,
        ),
      ).toBe(true);
      expect(['partial', 'complete']).toContain(level);
      record(
        driver,
        AREA,
        'inline SVG fill/stroke/currentColor/multi-color/text/use',
        'INFO',
        `coverage svg=${level}; findings ${svgFindings.join(' ')}; computed after adaptation ${JSON.stringify(changed)}`,
      );
      const imgLevel = coverageLevel(snap, 'image-pixels');
      record(
        driver,
        AREA,
        'SVG as an <img> (external SVG)',
        'INFO',
        `image-pixels coverage=${imgLevel}; img src is never recolored with adaptImages off`,
      );
      expect(
        await tab.evaluate<string>(`document.getElementById('svgimg').getAttribute('src')`),
      ).toBe('/icon.svg');
      await tab.close();
    });

    test('Canvas: pixels are never touched and the audit does not pretend to analyze them', async () => {
      const tab = await openPage(
        'canvas',
        html(`
        <canvas id="chart" class="sales-chart" width="300" height="100"></canvas>
        <canvas id="game" class="game-canvas" width="300" height="100"></canvas>
        <script>
          for (const id of ['chart', 'game']) {
            const g = document.getElementById(id).getContext('2d');
            g.fillStyle = '#d62728'; g.fillRect(10, 10, 80, 80); g.fillStyle = '#2ca02c'; g.fillRect(110, 10, 80, 80);
          }
        </script>`),
      );
      const hash = () =>
        tab.evaluate<string>(
          `document.getElementById('chart').toDataURL().length + ':' + document.getElementById('game').toDataURL().length + ':' + document.getElementById('chart').toDataURL().slice(-64)`,
        );
      const before = await hash();
      await tab.ext('REFRESH_ADAPTATION');
      await settled(tab);
      const snap = await auditRun(tab);
      expect(await hash()).toBe(before); // pixels untouched
      const canvasRules = snap.findings.filter((f) => f.ruleId === 'CA-CHART-004');
      expect(snap.coverage.canvases).toBe(2);
      // a canvas is a bitmap the audit cannot read: any finding about it is a manual review, never a confirmed one
      for (const f of canvasRules) expect(f.assessment).toBe('manual-review');
      expect(
        snap.findings.filter(
          (f) => f.assessment === 'issue' && f.affected.some((a) => a.locator.tag === 'canvas'),
        ),
      ).toEqual([]);
      record(
        driver,
        AREA,
        'canvas',
        'INFO',
        `UNSUPPORTED for analysis/adaptation (pixels untouched); audit: canvases counted ${snap.coverage.canvases}, CA-CHART-004 manual-review findings ${canvasRules.length}; charts coverage=${coverageLevel(snap, 'charts')}`,
      );
      await tab.close();
    });

    test('Images: raster, text-in-image, background-image, transparent PNG, picture/srcset, lazy', async () => {
      server.serveRaw(
        'banner.png',
        textPng('SALE 50%', 4, [210, 210, 210], [255, 255, 255]),
        'image/png',
      );
      server.serveRaw('hero.png', solidPng(300, 120, [40, 90, 160]), 'image/png');
      server.serveRaw('icon-red.png', discPng(24, [214, 39, 40]), 'image/png');
      server.serveRaw('thumb.png', solidPng(60, 60, [200, 120, 30]), 'image/png');
      const body = html(`
        <img id="banner" src="/banner.png" alt="Sale 50% off" width="132" height="28">
        <div id="bg" style="background-image:url(/hero.png);width:300px;height:120px;color:#e0e0e0;font-size:20px">Text over a background image</div>
        <img id="icon" src="/icon-red.png" alt="error" width="24" height="24">
        <picture><source srcset="/thumb.png" media="(min-width: 1px)"><img id="pic" src="/thumb.png" alt="thumbnail" width="60" height="60"></picture>
        <img id="resp" src="/thumb.png" srcset="/thumb.png 1x, /hero.png 2x" alt="responsive" width="60" height="60">
        <img id="lazy" loading="lazy" src="/thumb.png" alt="lazy" width="60" height="60" style="margin-top:2000px">`);
      for (const adaptImages of [false, true]) {
        const settings = { ...SETTINGS_ON, adaptImages };
        const tab = await openPage('images', body, settings);
        await tab.evaluate(
          `new Promise((r) => { const imgs = [...document.images].filter((i) => i.loading !== 'lazy'); Promise.all(imgs.map((i) => i.decode().catch(() => null))).then(r); })`,
        );
        await tab.ext('REFRESH_ADAPTATION');
        await settled(tab);
        const snap = await auditRun(tab);
        const imgRules = snap.findings
          .filter((f) => f.ruleId.startsWith('CA-IMG'))
          .map((f) => `${f.ruleId}:${f.assessment}:${f.affectedCount}`);
        const srcs = await tab.evaluate<string[]>(
          `[...document.images].map((i) => i.getAttribute('src'))`,
        );
        // sources of the page's images are never rewritten (adapted icons are drawn through a style, not a new src)
        expect(srcs.filter((s) => s !== null && s.startsWith('data:'))).toEqual([]);
        record(
          driver,
          AREA,
          `images with adaptImages=${adaptImages}`,
          'INFO',
          `coverage image-pixels=${coverageLevel(snap, 'image-pixels')}; findings ${imgRules.join(' ') || 'none'}; images counted ${snap.coverage.images}; text inside images is never read (no OCR): UNSUPPORTED`,
        );
        await tab.close();
      }
    });

    test('Charts: the known per-site adaptCharts debt, and what the audit says about charts', async () => {
      server.serveRaw(
        'charts',
        readFileSync(path.join(PAGES, 'charts.html')),
        'text/html; charset=utf-8',
      );
      const draw = (tab: Tab) =>
        tab.evaluate<string>(
          `window.chartKit.line({ id: 'c1', series: [{ name: 'Red', color: '#d62728' }, { name: 'Green', color: '#2ca02c' }], legend: 'svg' })`,
        );
      // 1. adaptCharts on globally: the chart is made distinguishable, the audit reports the source problem
      await driver.setSettings({ ...SETTINGS_ON, adaptCharts: true });
      let tab = await driver.newTab();
      await tab.open(`${server.origin}/charts`);
      await until(() => tab.ext('GET_DYNAMIC_DIAGNOSTICS'), 'content script');
      await draw(tab);
      await tab.ext('ENABLE_ADAPTATION');
      await settled(tab);
      const marked = (t: Tab) =>
        t.evaluate<number>(
          `document.querySelectorAll('[data-coloradapt-chart-mark],[data-coloradapt-chart-node]').length`,
        );
      const globalOn = await marked(tab);
      const snapOn = await auditRun(tab);
      expect(snapOn.findings.some((f) => f.ruleId === 'CA-CHART-001')).toBe(true);
      await tab.close();

      // 2. adaptCharts off globally: no chart change, and the audit does not describe charts as complete
      await driver.setSettings({ ...SETTINGS_ON, adaptCharts: false });
      tab = await driver.newTab();
      await tab.open(`${server.origin}/charts`);
      await until(() => tab.ext('GET_DYNAMIC_DIAGNOSTICS'), 'content script');
      await draw(tab);
      await tab.ext('ENABLE_ADAPTATION');
      await settled(tab);
      const globalOff = await marked(tab);
      const snapOff = await auditRun(tab);
      expect(globalOff).toBe(0);
      expect(coverageLevel(snapOff, 'charts')).not.toBe('complete');
      expect(snapOff.findings.some((f) => f.ruleId === 'CA-CHART-001')).toBe(true); // the audit still reports the source problem
      await tab.close();

      // 3. the per-site setting: stored, not consulted by the chart runtime (frozen M7 behavior, M12 debt)
      await driver.setSettings({
        ...SETTINGS_ON,
        adaptCharts: true,
        siteOverrides: {
          '127.0.0.1': {
            hostname: '127.0.0.1',
            enabled: true,
            visionProfile: 'deuteranopia',
            intensity: 1,
            adaptUI: true,
            adaptCharts: false,
            adaptImages: false,
          },
        },
      });
      tab = await driver.newTab();
      await tab.open(`${server.origin}/charts`);
      await until(() => tab.ext('GET_DYNAMIC_DIAGNOSTICS'), 'content script');
      await draw(tab);
      await tab.ext('ENABLE_ADAPTATION');
      await settled(tab);
      const perSite = await marked(tab);
      const snapSite = await auditRun(tab);
      record(
        driver,
        AREA,
        'charts: global adaptCharts on/off',
        'PASS',
        `chart nodes marked: on=${globalOn} off=${globalOff}; audit charts coverage with adaptCharts off: ${coverageLevel(snapOff, 'charts')}`,
      );
      record(
        driver,
        AREA,
        'charts: per-site adaptCharts is not consulted by the runtime (KNOWN DEBT -> M12)',
        'INFO',
        `site override adaptCharts=false, global true: chart nodes marked=${perSite} (${perSite > 0 ? 'still adapted: debt confirmed' : 'respected'}); audit charts coverage=${coverageLevel(snapSite, 'charts')}`,
      );
      await tab.close();
    });

    test('iframes: same-origin, cross-origin and nested frames are not analyzed, and the audit says so', async () => {
      server.serve(
        'frame-inner',
        html(
          '<p id="inner-cvd" class="cvd">inner frame text, red on green</p><p id="inner-low" class="low">inner low contrast</p>',
        ),
      );
      server.serve(
        'frame-nested',
        html(
          `<p id="mid-cvd" class="cvd">middle frame</p><iframe id="deep" src="${server.origin}/frame-inner" width="400" height="120"></iframe>`,
        ),
      );
      const tab = await openPage(
        'frames',
        html(`
        <p id="top-cvd" class="cvd">top frame text, red on green</p>
        <iframe id="same" src="${server.origin}/frame-inner" width="400" height="120"></iframe>
        <iframe id="cross" src="${server.altOrigin}/frame-inner" width="400" height="120"></iframe>
        <iframe id="nest" src="${server.origin}/frame-nested" width="500" height="260"></iframe>`),
      );
      // same-origin frames expose their document; a cross-origin frame cannot be asked, so give it the page's own load signal
      await until(
        () =>
          tab.evaluate<boolean>(
            `[...document.querySelectorAll('iframe')].every((f) => { try { return f.contentDocument === null || f.contentDocument.readyState === 'complete'; } catch { return true; } })`,
          ),
        'frames loaded',
      );
      const snap = await auditRun(tab);
      const seen = affected(snap, 'CA-COLOR-001').concat(affected(snap, 'CA-COLOR-002'));
      expect(seen).not.toContain('#inner-cvd');
      expect(seen).not.toContain('#inner-low');
      expect(seen).not.toContain('#mid-cvd');
      expect(coverageLevel(snap, 'iframes')).toBe('unsupported');
      const same = await tab.evaluate<string>(
        `getComputedStyle(document.getElementById('same').contentDocument.getElementById('inner-cvd')).color`,
      );
      const top = await tab.evaluate<string>(deepColor('#top-cvd'));
      expect(top).not.toBe('rgb(214, 39, 40)'); // the top frame itself is adapted
      record(
        driver,
        AREA,
        'iframes: same-origin, cross-origin, nested',
        'INFO',
        `UNSUPPORTED (content script runs in the top frame only): inner frame text color ${same === 'rgb(214, 39, 40)' ? 'untouched' : 'changed'}; audit iframes coverage=${coverageLevel(snap, 'iframes')}; findings from inside frames: 0`,
      );
      await tab.close();
    });

    test('hostile CSP: no unsafe-eval, no script injection, the stylesheet still applies; what the page can observe', async () => {
      const CSP =
        "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; frame-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; report-uri /csp-report";
      await driver.setSettings(SETTINGS_ON);
      server.serveRaw(
        'csp.css',
        '.cvd { color: #d62728; background-color: #2ca02c; } body { font: 16px sans-serif }',
        'text/css',
      );
      // the page's own script (allowed by script-src 'self') records every CSP violation event it can see
      server.serveRaw(
        'csp.js',
        "window.__violations = []; document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(e.violatedDirective + '|' + e.blockedURI + '|' + e.sourceFile));",
        'text/javascript',
      );
      server.serveRaw('csp-report', '', 'text/plain');
      server.serve(
        'csp',
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>csp</title><script src="/csp.js"></script><link rel="stylesheet" href="/csp.css"></head><body><p id="cvd" class="cvd">strict CSP page, red on green</p></body></html>',
        { 'content-security-policy': CSP },
      );
      const reportsBefore = server.hits('csp-report');
      const tab = await driver.newTab();
      await tab.open(`${server.origin}/csp`);
      await until(() => tab.ext('GET_DYNAMIC_DIAGNOSTICS'), 'content script under a strict CSP');
      await tab.ext('ENABLE_ADAPTATION');
      await settled(tab);
      const color = await tab.evaluate<string>(deepColor('#cvd'));
      const styled = await hasStylesheet(tab);
      const snap = await auditRun(tab);
      const events = await tab.evaluate<string[]>('window.__violations');
      const consoleViolations = tab
        .drainLogs()
        .filter((l) => /content.security.policy|Параметры страницы/i.test(l.text));
      await sleep(500); // a report is sent asynchronously by the browser
      const reports = server.hits('csp-report') - reportsBefore;
      const reportBody = server.bodies('csp-report').slice(-1)[0] ?? '';
      record(
        driver,
        AREA,
        'strict CSP page (style-src self, no unsafe-inline/eval)',
        styled && color !== 'rgb(214, 39, 40)' ? 'PASS' : 'FAIL',
        `stylesheet injected=${styled}, adapted color=${color}, audit findings=${snap.findings.length}; page-visible CSP violation events=${events.length}${events[0] ? ' (' + events[0].slice(0, 100) + ')' : ''}; report-uri hits=${reports}${reportBody ? ' body=' + reportBody.replace(/\s+/g, ' ').slice(0, 260) : ''}; console CSP messages=${consoleViolations.length}`,
      );
      expect(styled).toBe(true);
      expect(color).not.toBe('rgb(214, 39, 40)');
      // ColorAdapt never asks the page for unsafe-eval/unsafe-inline: a script violation (eval) would show up here
      expect(events.filter((e) => /script-src/.test(e))).toEqual([]);
      await tab.close();
    });
  });
}

/** Keep the type import used in every compile configuration. */
export type { AuditSnapshot };
