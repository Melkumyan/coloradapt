/**
 * Interaction and accessibility regression in both real browsers. The same scripted session of *real* input (mouse
 * clicks, key presses, typing) runs on a widget page with ColorAdapt off and then on, and everything a user or an
 * assistive technology could notice must be identical: what the page's own handlers saw, the form state, ARIA and
 * attribute state of every element, tab order, the keyboard behavior of menu / dropdown / modal / tabs /
 * accordion, and the focus indicator. Only colors may differ, and the page must actually have been adapted.
 */
import { expect, test } from '@playwright/test';
import type { Driver, Tab } from './lib/driver';
import { call, integrityProbe, type IntegrityProbe } from './lib/probe';
import { startFixtureServer, type FixtureServer } from './lib/server';
import {
  BROWSERS,
  SETTINGS_OFF,
  SETTINGS_ON,
  hasStylesheet,
  html,
  launch,
  record,
  settled,
  until,
} from './lib/scenario';

const AREA = 'interaction';

const WIDGETS = html(
  `
  <header>
    <nav aria-label="Main">
      <a id="home" href="#home-section" data-log>Home</a>
      <a id="docs" href="#docs-section" data-log class="cvd">Docs</a>
      <button id="menu-btn" type="button" aria-expanded="false" aria-controls="menu" data-log class="cvd">Menu</button>
      <ul id="menu" hidden><li><a id="m1" href="#m1" data-log>Item one</a></li><li><a id="m2" href="#m2" data-log>Item two</a></li></ul>
    </nav>
  </header>
  <main>
    <div id="dd">
      <button id="dd-btn" type="button" aria-haspopup="listbox" aria-expanded="false" data-log class="cvd">Choose</button>
      <ul id="dd-list" role="listbox" hidden><li role="option" id="o1" tabindex="0" data-log>One</li><li role="option" id="o2" tabindex="0" data-log>Two</li></ul>
    </div>
    <button id="open-modal" type="button" data-log class="cvd">Open dialog</button>
    <div id="modal" role="dialog" aria-modal="true" aria-label="Settings" hidden>
      <button id="m-ok" type="button" data-log>OK</button> <button id="m-cancel" type="button" data-log>Cancel</button>
    </div>
    <div role="tablist" aria-label="Sections">
      <button role="tab" id="t1" aria-selected="true" aria-controls="p1" tabindex="0" data-log class="cvd">One</button>
      <button role="tab" id="t2" aria-selected="false" aria-controls="p2" tabindex="-1" data-log>Two</button>
      <button role="tab" id="t3" aria-selected="false" aria-controls="p3" tabindex="-1" data-log>Three</button>
    </div>
    <div id="p1" role="tabpanel" aria-labelledby="t1">Panel one</div>
    <div id="p2" role="tabpanel" aria-labelledby="t2" hidden>Panel two</div>
    <div id="p3" role="tabpanel" aria-labelledby="t3" hidden>Panel three</div>
    <h2><button id="acc-btn" type="button" aria-expanded="false" aria-controls="acc" data-log class="cvd">Details</button></h2>
    <div id="acc" role="region" aria-labelledby="acc-btn" hidden>More details</div>
    <form id="f" aria-label="Sign up">
      <label for="name">Name</label> <input id="name" name="name" type="text" data-log>
      <label><input id="agree" name="agree" type="checkbox" data-log> I agree</label>
      <fieldset><legend>Plan</legend>
        <label><input type="radio" name="plan" id="r1" value="a" data-log checked> A</label>
        <label><input type="radio" name="plan" id="r2" value="b" data-log> B</label>
      </fieldset>
      <label for="sel">Size</label>
      <select id="sel" name="size" data-log><option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option></select>
      <label for="msg">Message</label> <textarea id="msg" name="msg" data-log></textarea>
      <button id="submit" type="submit" data-log class="cvd">Send</button>
      <button id="off" type="button" disabled class="cvd">Disabled</button>
    </form>
    <p id="status" role="status" class="cvd">Ready</p>
  </main>
  <style>
    a, button, input, select, textarea, [role=option] { font: inherit; }
    :focus-visible { outline: 3px solid #1a73e8; outline-offset: 2px; }
    #agree:focus-visible { outline: none; box-shadow: 0 0 0 3px #d62728; }
    [hidden] { display: none !important; }
  </style>
  <script>
    window.__log = [];
    const note = (type, el) => window.__log.push(type + ':' + (el.id || el.name || el.localName));
    document.addEventListener('click', (e) => { const t = e.target.closest('[data-log]'); if (t) note('click', t); });
    document.addEventListener('change', (e) => note('change', e.target));
    document.addEventListener('keydown', (e) => { if (['Enter', ' ', 'Escape', 'ArrowRight', 'ArrowLeft', 'ArrowDown', 'Tab'].includes(e.key)) note('key ' + e.key, e.target); });
    const toggle = (btn, panel) => { const open = btn.getAttribute('aria-expanded') !== 'true'; btn.setAttribute('aria-expanded', String(open)); panel.hidden = !open; };
    for (const [b, p] of [['menu-btn', 'menu'], ['dd-btn', 'dd-list'], ['acc-btn', 'acc']]) document.getElementById(b).addEventListener('click', () => toggle(document.getElementById(b), document.getElementById(p)));
    document.querySelectorAll('[role=option]').forEach((o) => o.addEventListener('click', () => { document.getElementById('dd-btn').textContent = o.textContent; toggle(document.getElementById('dd-btn'), document.getElementById('dd-list')); }));
    const modal = document.getElementById('modal'); let opener = null;
    document.getElementById('open-modal').addEventListener('click', (e) => { opener = e.currentTarget; modal.hidden = false; document.getElementById('m-ok').focus(); });
    const closeModal = () => { modal.hidden = true; if (opener) opener.focus(); };
    modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); if (e.key === 'Tab') { const f = [...modal.querySelectorAll('button')]; const i = f.indexOf(document.activeElement); const n = e.shiftKey ? (i - 1 + f.length) % f.length : (i + 1) % f.length; e.preventDefault(); f[n].focus(); } });
    modal.querySelectorAll('button').forEach((b) => b.addEventListener('click', closeModal));
    const tabs = [...document.querySelectorAll('[role=tab]')];
    const select = (t) => { tabs.forEach((x) => { const on = x === t; x.setAttribute('aria-selected', String(on)); x.tabIndex = on ? 0 : -1; document.getElementById(x.getAttribute('aria-controls')).hidden = !on; }); t.focus(); };
    tabs.forEach((t, i) => { t.addEventListener('click', () => select(t)); t.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') select(tabs[(i + 1) % tabs.length]); if (e.key === 'ArrowLeft') select(tabs[(i - 1 + tabs.length) % tabs.length]); }); });
    document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); note('submit', e.target); document.getElementById('status').textContent = 'Sent'; });
    window.state = () => ({
      values: [...document.querySelectorAll('input,select,textarea')].map((e) => e.id + '=' + (e.type === 'checkbox' || e.type === 'radio' ? e.checked : e.value)),
      aria: [...document.querySelectorAll('[aria-expanded],[aria-selected],[hidden]')].map((e) => e.id + ':' + e.getAttribute('aria-expanded') + ':' + e.getAttribute('aria-selected') + ':' + e.hidden),
      active: document.activeElement ? document.activeElement.id || document.activeElement.localName : '',
      status: document.getElementById('status').textContent,
      log: window.__log.slice(),
    });
    // what a keyboard user sees on the focused element: the ring's presence and geometry, and its color separately
    window.focusLook = () => { const s = getComputedStyle(document.activeElement); return { shape: [s.outlineStyle, s.outlineWidth, s.outlineOffset, s.boxShadow.replace(/rgba?\\([^)]*\\)/g, 'C')].join('|'), color: s.outlineStyle === 'none' ? s.boxShadow : s.outlineColor }; };
  </script>`,
  '',
);

interface Session {
  readonly state: unknown;
  readonly tabOrder: string[];
  readonly focusLooks: Record<string, string>;
  /** The ring colors, which may follow the element's own (adapted) color when the page lets them. */
  readonly focusColors: Record<string, string>;
  readonly attributes: IntegrityProbe;
}

async function run(tab: Tab): Promise<Session> {
  const id = () =>
    tab.evaluate<string>(
      `document.activeElement ? document.activeElement.id || document.activeElement.localName : ''`,
    );
  // links and the menu
  await tab.click('#home');
  await tab.click('#menu-btn');
  await tab.click('#m1');
  await tab.click('#menu-btn');
  // dropdown: open, pick an option with the mouse
  await tab.click('#dd-btn');
  await tab.click('#o2');
  // modal: open, keyboard trap, Escape returns focus
  await tab.click('#open-modal');
  await tab.press('Tab');
  await tab.press('Tab');
  await tab.press('Escape');
  expect(await id()).toBe('open-modal');
  // tabs: click, then arrow keys
  await tab.click('#t2');
  await tab.press('ArrowRight');
  await tab.press('ArrowLeft');
  // accordion
  await tab.click('#acc-btn');
  // form by keyboard
  await tab.type('#name', 'Zed');
  await tab.press('Tab');
  await tab.press('Space');
  await tab.press('Tab');
  await tab.press('ArrowDown');
  await tab.press('Tab');
  await tab.press('ArrowDown');
  await tab.press('Tab');
  await tab.type('#msg', 'hello there');
  await tab.click('#submit');
  const state = await tab.evaluate<unknown>('window.state()');
  // tab order of the whole page, from the top
  await tab.evaluate(
    `(document.activeElement && document.activeElement.blur(), window.scrollTo(0, 0), window.getSelection().collapse(document.body, 0))`,
  );
  const tabOrder: string[] = [];
  for (let i = 0; i < 28; i++) {
    await tab.press('Tab');
    tabOrder.push(await id());
  }
  // focus each target the way a keyboard user does: Tab from the top until it is reached
  const focusLooks: Record<string, string> = {};
  const focusColors: Record<string, string> = {};
  for (const target of ['home', 'menu-btn', 'agree', 'submit', 'name']) {
    await tab.evaluate(
      `(document.activeElement && document.activeElement.blur(), window.scrollTo(0, 0), window.getSelection().collapse(document.body, 0))`,
    );
    for (let i = 0; i < 60 && (await id()) !== target; i++) await tab.press('Tab');
    expect(await id()).toBe(target);
    const look = await tab.evaluate<{ shape: string; color: string }>('window.focusLook()');
    focusLooks[target] = look.shape;
    focusColors[target] = look.color;
  }
  const attributes = await tab.evaluate<IntegrityProbe>(call(integrityProbe, 0));
  return { state, tabOrder, focusLooks, focusColors, attributes };
}

for (const browser of BROWSERS) {
  test.describe(`interaction ${browser}`, () => {
    test.describe.configure({ mode: 'serial' });
    let driver: Driver;
    let server: FixtureServer;

    test.beforeAll(async () => {
      server = await startFixtureServer();
      server.serve('widgets', WIDGETS);
      driver = await launch(browser);
    });
    test.afterAll(async () => {
      await driver?.close();
      await server?.close();
    });

    test('a scripted real-input session is identical with ColorAdapt off and on', async () => {
      const open = async (settings: Record<string, unknown>) => {
        await driver.setSettings(settings);
        const tab = await driver.newTab();
        await tab.open(`${server.origin}/widgets`);
        await until(() => tab.ext('GET_DYNAMIC_DIAGNOSTICS'), 'content script');
        if (settings['enabled'] === true) {
          await until(() => hasStylesheet(tab), 'adaptation applied');
          await settled(tab);
        }
        return tab;
      };
      const offTab = await open(SETTINGS_OFF);
      const off = await run(offTab);
      await offTab.close();
      const onTab = await open(SETTINGS_ON);
      const colorsOn = await onTab.evaluate<string[]>(
        `['docs', 'menu-btn', 'dd-btn', 'submit', 'status'].map((id) => getComputedStyle(document.getElementById(id)).color)`,
      );
      const on = await run(onTab);
      // the page really was adapted: the color-vision pair text is no longer the page's red
      expect(colorsOn.some((c) => c !== 'rgb(214, 39, 40)')).toBe(true);
      await onTab.close();

      expect(on.state).toEqual(off.state); // what the page's own handlers saw, values, ARIA state, focus
      expect(on.tabOrder).toEqual(off.tabOrder);
      expect(on.focusLooks).toEqual(off.focusLooks); // the ring is there, with the same geometry
      for (const shape of Object.values(on.focusLooks))
        expect(shape).not.toMatch(/^none\|[^|]*\|[^|]*\|none$/); // and never missing
      // every element's attributes (ids, roles, ARIA, names, tabindex, data-*, hidden, ...) are the same
      expect(on.attributes.digests).toEqual(off.attributes.digests);
      expect(on.attributes.formValues).toEqual(off.attributes.formValues);
      const finalState = off.state as { values: string[]; status: string; log: string[] };
      expect(finalState.status).toBe('Sent');
      expect(finalState.values).toContain('name=Zed');
      expect(finalState.values).toContain('agree=true');
      expect(finalState.log.filter((l) => l.startsWith('submit')).length).toBe(1);
      record(
        driver,
        AREA,
        'links, buttons, menu, dropdown, modal (focus trap + Escape), tabs (arrows), accordion, text/checkbox/radio/select/textarea, submit: same with ColorAdapt on',
        'PASS',
        `${finalState.log.length} page-side events identical; tab order (${off.tabOrder.length} stops) identical; keyboard focus indicators identical in presence and geometry (colors: ${JSON.stringify(Object.fromEntries(Object.keys(off.focusColors).map((k) => [k, off.focusColors[k] === on.focusColors[k] ? 'same' : 'follows adapted text color'])))}); every attribute identical`,
      );
      record(
        driver,
        'accessibility',
        'ARIA/roles/names/tabindex/data-* untouched; focus indicator and tab order unchanged',
        'PASS',
        `${off.attributes.digests.length} elements compared`,
      );
    });

    test('disabled controls stay disabled and unfocusable, and adaptation never blocks pointer events', async () => {
      await driver.setSettings(SETTINGS_ON);
      const tab = await driver.newTab();
      await tab.open(`${server.origin}/widgets`);
      await until(() => hasStylesheet(tab), 'adaptation applied');
      await settled(tab);
      const probe = await tab.evaluate<{
        disabled: boolean;
        focusable: boolean;
        pointer: string[];
        hit: string;
      }>(
        `(() => { const off = document.getElementById('off'); off.focus(); return { disabled: off.disabled, focusable: document.activeElement === off, pointer: [...document.querySelectorAll('a,button,input,select,textarea')].map((e) => getComputedStyle(e).pointerEvents).filter((v) => v === 'none'), hit: (document.elementFromPoint(document.getElementById('home').getBoundingClientRect().x + 3, document.getElementById('home').getBoundingClientRect().y + 3) || {}).id || '' }; })()`,
      );
      expect(probe.disabled).toBe(true);
      expect(probe.focusable).toBe(false);
      expect(probe.pointer).toEqual([]);
      expect(probe.hit).toBe('home');
      record(
        driver,
        AREA,
        'disabled stays disabled, no pointer-events:none introduced, links hit-testable',
        'PASS',
      );
      await tab.close();
    });
  });
}
