import { expect, test, type Page } from '@playwright/test';
import {
  disable,
  dynamicDiagnostics,
  flushDynamic,
  launchExtension,
  refresh,
  setSettings,
  settle,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';
import { load } from './r1-kit';
import {
  INITIAL_CUES,
  NEVER_CUED,
  SETTINGS,
  accessibilityTree,
  cues,
  expectCues,
  hasCueSheet,
  openOff,
  pageStructure,
  tabOrder,
  turnOn,
} from './semantic-kit';

/**
 * M6.R1 in a real browser, part 1: the cues are visual only. The accessibility tree, accessible
 * names, focus order, clicks, typing, selection, validity and form submission are the same with
 * the cues as without them; ON/OFF and the settings behave as documented.
 *
 * "Accessibility tree" here is Chromium's (CDP `Accessibility.getFullAXTree` and Playwright's
 * `ariaSnapshot`). No screen reader was run.
 */
/** The slice of the extension API used inside `worker.evaluate` (a service worker, where `chrome` is a global). */
declare const chrome: {
  storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
};

/** What is actually in the profile's storage under the settings key (`undefined`: nothing written). */
const storedSettings = (worker: ExtensionSession['worker']) =>
  worker.evaluate(
    async () =>
      (await chrome.storage.local.get('coloradapt:settings'))['coloradapt:settings'] as
        Record<string, unknown> | undefined,
  );

let server: PageServer;
let ext: ExtensionSession;

test.beforeAll(async () => {
  server = await startPageServer();
  ext = await launchExtension();
});
test.afterEach(async () => {
  await Promise.all(ext.context.pages().map((page) => page.close()));
});
test.afterAll(async () => {
  await ext.close();
  await server.close();
});

interface AxEntry {
  readonly role: string | null;
  readonly ignored: boolean;
  readonly name: string | null;
  readonly description: string | null;
  readonly value: unknown;
  readonly props: string[];
}

/** Chromium's full accessibility tree, reduced to what a user of assistive technology can perceive. */
async function axTree(page: Page): Promise<AxEntry[]> {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send('Accessibility.enable');
    const { nodes } = await client.send('Accessibility.getFullAXTree');
    return nodes.map((node) => ({
      role: (node.role?.value as string | undefined) ?? null,
      ignored: node.ignored ?? false,
      // Whitespace is collapsed: a page that indents its markup has a collapsible space after its
      // text, which only becomes a (rendered, silent) space once an inline `::after` follows it.
      name: ((node.name?.value as string | undefined) ?? null)?.replace(/\s+/g, ' ').trim() ?? null,
      description: (node.description?.value as string | undefined) ?? null,
      value: node.value?.value ?? null,
      props: (node.properties ?? [])
        .map((p) => `${p.name}=${JSON.stringify(p.value?.value)}`)
        .sort(),
    }));
  } finally {
    await client.detach();
  }
}

const A11Y = 'semantic-a11y.html';
const A11Y_CUES = ['b1', 'b2', 'd1', 'd2', 'nav-home', 'seg1', 'tab1'];

test.describe('M6.R1 accessibility tree', () => {
  test('the full Chromium accessibility tree is identical with and without cues', async () => {
    const page = await openOff(ext, server, A11Y);
    const before = await axTree(page);
    const snapshotBefore = await accessibilityTree(page);
    expect(before.length).toBeGreaterThan(30);

    await turnOn(ext, page);
    const active = await cues(page);
    for (const id of A11Y_CUES) expect(active[id], `#${id} has a cue`).toBeDefined();

    expect(await axTree(page)).toEqual(before);
    expect(await accessibilityTree(page)).toBe(snapshotBefore);
  });

  test('role, accessible name, description and state of each kind of control are unchanged (raw, not normalized)', async () => {
    const page = await openOff(ext, server, A11Y);
    const targets: ReadonlyArray<readonly [string, string, string]> = [
      ['#seg1', 'button', 'Day'],
      ['#nav-home', 'link', 'Home'],
      ['#tab1', 'tab', 'Home'],
      ['#chk1', 'checkbox', 'Subscribe'],
      ['#email', 'textbox', 'Email'],
      ['#rad1', 'radio', 'Small'],
      ['#age', 'spinbutton', 'Age'],
      ['#b1', 'status', ''],
      ['#al1', 'alert', ''],
      ['#d1', 'generic', ''],
    ];
    const read = async () => {
      const client = await page.context().newCDPSession(page);
      try {
        await client.send('DOM.enable');
        await client.send('Accessibility.enable');
        const { root } = await client.send('DOM.getDocument');
        const out: Array<Record<string, unknown>> = [];
        for (const [selector] of targets) {
          const { nodeId } = await client.send('DOM.querySelector', {
            nodeId: root.nodeId,
            selector,
          });
          const { nodes } = await client.send('Accessibility.getPartialAXTree', {
            nodeId,
            fetchRelatives: false,
          });
          const node = nodes[0]!;
          out.push({
            selector,
            role: node.role?.value,
            name: node.name?.value,
            description: node.description?.value ?? null,
            ignored: node.ignored ?? false,
            props: (node.properties ?? [])
              .map((p) => `${p.name}=${JSON.stringify(p.value?.value)}`)
              .sort(),
          });
        }
        return out;
      } finally {
        await client.detach();
      }
    };
    const before = await read();
    // The probe reads what it claims to: the roles and names of the controls the milestone lists.
    for (const [index, [selector, role, name]] of targets.entries()) {
      expect(before[index]!['role'], selector).toBe(role);
      if (name) expect(before[index]!['name'], selector).toBe(name);
    }
    expect(before.find((n) => n['selector'] === '#al1')!['description']).toBe('Try again later');

    await turnOn(ext, page);
    const active = await cues(page);
    for (const id of ['seg1', 'nav-home', 'tab1', 'b1', 'd1']) expect(active[id], id).toBeDefined();
    expect(await read()).toEqual(before);
  });

  test('aria-label, aria-describedby and title are the pages own, byte for byte', async () => {
    const page = await openOff(ext, server, A11Y);
    const read = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[aria-describedby], [aria-label], [title]')].map((el) => [
          el.id,
          el.getAttribute('aria-describedby'),
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
        ]),
      );
    const before = await read();
    expect(before.length).toBeGreaterThan(4);
    await turnOn(ext, page);
    expect(await read()).toEqual(before);
  });

  test('the DOM the page wrote is untouched: only ColorAdapt attributes differ, no node was added', async () => {
    const page = await openOff(ext, server, A11Y);
    const structure = await pageStructure(page);
    const nodeCount = await page.evaluate(() => document.body.querySelectorAll('*').length);
    await turnOn(ext, page);
    expect(await pageStructure(page)).toBe(structure);
    expect(await page.evaluate(() => document.body.querySelectorAll('*').length)).toBe(nodeCount);
    // The cue is an attribute and a stylesheet rule; nothing a screen reader can land on.
    const hostsWithTabindex = await page.evaluate(
      () => document.querySelectorAll('[data-coloradapt-cue][tabindex]').length,
    );
    expect(hostsWithTabindex).toBe(0);
  });
});

test.describe('M6.R1 keyboard', () => {
  test('Tab visits the same controls in the same order; cue pseudo-elements are never focus targets', async () => {
    const plain = await openOff(ext, server, A11Y);
    const focusableBefore = await plain.evaluate(
      () => document.querySelectorAll('a[href], button, input, [tabindex]').length,
    );
    const before = await tabOrder(plain, 24);
    await plain.close();

    const page = await openOff(ext, server, A11Y);
    await turnOn(ext, page);
    const after = await tabOrder(page, 24);
    expect(after).toEqual(before);
    expect(
      await page.evaluate(
        () => document.querySelectorAll('a[href], button, input, [tabindex]').length,
      ),
    ).toBe(focusableBefore);
    // Every stop is a real control of the page (never a cue, which has no element).
    for (const id of after) expect(id).not.toMatch(/coloradapt/i);
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('STYLE');
  });

  test('keys keep their meaning on cued controls: Enter on a tab, Space on a checkbox and a segment', async () => {
    const page = await openOff(ext, server, A11Y);
    await turnOn(ext, page);
    await page.locator('#tab3').focus();
    await page.keyboard.press('Enter');
    expect(await page.locator('#tab3').getAttribute('aria-selected')).toBe('true');
    await page.locator('#chk2').focus();
    await page.keyboard.press('Space');
    expect(await page.locator('#chk2').isChecked()).toBe(true);
    await page.locator('#seg2').focus();
    await page.keyboard.press('Space');
    expect(await page.locator('#seg2').getAttribute('aria-pressed')).toBe('true');
  });
});

test.describe('M6.R1 pointer', () => {
  test('button, link, tab, checkbox and radio work with cues active, and the underline follows', async () => {
    const page = await openOff(ext, server, A11Y);
    await turnOn(ext, page);
    const url = page.url();

    await page.locator('#seg2').click();
    await page.locator('#nav-about').click();
    await page.locator('#tab2').click();
    await page.locator('#chk2').click();
    await page.locator('#rad2').click();
    await page.locator('#b1').click();

    const log = await page.evaluate(() => window.log.clicks);
    expect(log).toEqual({ b1: 1, tab2: 1, link: 1, seg2: 1, chk2: 1, rad2: 1 });
    expect(page.url()).toBe(url); // the link handler prevented navigation, not a cue
    expect(await page.locator('#chk2').isChecked()).toBe(true);
    expect(await page.locator('#rad2').isChecked()).toBe(true);
    expect(await page.locator('#rad1').isChecked()).toBe(false);
    expect(await page.locator('#tab2').getAttribute('aria-selected')).toBe('true');

    // The cues followed the SPA state: underline on the new tab and segment, not the old ones.
    await flushDynamic(ext.worker, page);
    await settle(page);
    const now = await cues(page);
    expect(now['tab2']).toBe('underline');
    expect(now['tab1']).toBeUndefined();
    expect(now['seg2']).toBe('underline');
    expect(now['seg1']).toBeUndefined();
  });

  test('clicking the exact spot where a glyph is drawn is a click on the element', async () => {
    const page = await openOff(ext, server, A11Y);
    await turnOn(ext, page);
    for (const id of ['b1', 'b2', 'd1']) {
      const box = (await page.locator(`#${id}`).boundingBox())!;
      const hit = await page.evaluate(
        ([x, y]) => document.elementFromPoint(x!, y!)?.id,
        [box.x + box.width - 2, box.y + box.height / 2],
      );
      expect(hit, `#${id}`).toBe(id);
    }
  });
});

/** Everything observable about the three fields and the form's behaviour while it is being used. */
async function driveForm(page: Page) {
  const fieldState = () =>
    page.evaluate(() => {
      const out: Record<string, unknown> = {};
      for (const id of ['email', 'name', 'age']) {
        const el = document.getElementById(id) as HTMLInputElement;
        const v = el.validity;
        out[id] = {
          value: el.value,
          placeholder: el.placeholder,
          required: el.required,
          disabled: el.disabled,
          type: el.type,
          selection: [el.selectionStart, el.selectionEnd],
          validity: {
            valid: v.valid,
            valueMissing: v.valueMissing,
            typeMismatch: v.typeMismatch,
            rangeUnderflow: v.rangeUnderflow,
          },
          message: el.validationMessage,
          invalidPseudo: el.matches(':invalid'),
          focused: document.activeElement === el,
        };
      }
      return out;
    });
  const record: Record<string, unknown> = {};

  await page.locator('#email').focus();
  await page.keyboard.type('abc');
  await page.keyboard.press('Control+A');
  record['afterSelectAll'] = await fieldState();
  await page.keyboard.press('Backspace');
  await page.keyboard.type('a@b.co');
  record['afterTyping'] = await fieldState();
  await page.keyboard.press('Tab'); // blur
  record['afterBlur'] = await fieldState();

  await page.locator('#name').fill('Alice');
  await page.locator('#age').fill('5'); // below min
  record['beforeSubmit'] = await fieldState();

  await page.locator('#submit').click(); // the browser's own validation UI blocks it
  record['afterBlockedSubmit'] = await fieldState();
  record['blockedFocus'] = await page.evaluate(() => document.activeElement?.id);
  record['blockedLog'] = await page.evaluate(() => ({
    submitted: window.log.submitted,
    invalid: window.log.invalid,
  }));

  await page.locator('#age').fill('30');
  await page.locator('#submit').click();
  record['submittedLog'] = await page.evaluate(() => ({
    submitted: window.log.submitted,
    invalid: window.log.invalid,
  }));

  await page.locator('#reset').click();
  record['afterReset'] = await fieldState();
  record['events'] = await page.evaluate(() => window.log.events);
  return record;
}

test.describe('M6.R1 input and form behavior', () => {
  test('typing, selection, focus, blur, validation and submission are identical with and without cues', async () => {
    const plain = await openOff(ext, server, A11Y);
    const before = await driveForm(plain);
    await plain.close();

    const page = await openOff(ext, server, A11Y);
    await turnOn(ext, page);
    const after = await driveForm(page);
    expect(after).toEqual(before);
    // The run really exercised the validation UI.
    expect(after['blockedLog']).toMatchObject({ submitted: 0 });
    expect((after['blockedLog'] as { invalid: number }).invalid).toBeGreaterThan(0);
    expect(after['submittedLog']).toMatchObject({ submitted: 1 });
  });

  test("ColorAdapt never writes a field: value, placeholder, required, disabled and validity are the page's", async () => {
    const page = await openOff(ext, server, A11Y);
    const read = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('input, button')].map((el) => {
          const input = el as HTMLInputElement;
          return {
            id: el.id,
            attrs: el
              .getAttributeNames()
              .filter((n) => !n.startsWith('data-coloradapt-'))
              .map((n) => `${n}=${el.getAttribute(n)}`),
            value: input.value,
            valid: input.validity?.valid,
          };
        }),
      );
    const before = await read();
    await turnOn(ext, page);
    expect(await read()).toEqual(before);
  });
});

test.describe('M6.R1 native validity in the browser', () => {
  test('untouched required -> touched invalid -> valid -> invalid again -> reset, exactly per policy', async () => {
    const { page, step } = await load(ext, server, A11Y, SETTINGS);
    const emailCue = async () => (await cues(page))['email'];

    // untouched and required: a requirement, not an error: no cue
    expect(await emailCue()).toBeUndefined();

    await page.locator('#email').focus();
    await page.keyboard.type('nope');
    await page.keyboard.press('Tab'); // blur: now :user-invalid
    await step();
    expect(await emailCue()).toBe('outline:dashed');

    await page.locator('#email').fill('a@b.co');
    await step();
    expect(await emailCue()).toBeUndefined();

    await page.locator('#email').fill('x');
    await page.locator('#name').focus();
    await step();
    expect(await emailCue()).toBe('outline:dashed');

    // reset puts the form back: no event on the field, and the cue goes
    await page.locator('#reset').click();
    await step();
    expect(await page.locator('#email').inputValue()).toBe('');
    expect(await emailCue()).toBeUndefined();
  });

  test('a failed submit marks every invalid field (the `invalid` events), and a fixed form clears them', async () => {
    const { page, step } = await load(ext, server, A11Y, SETTINGS);
    await page.locator('#email').fill('bad');
    await page.locator('#age').fill('3');
    await page.locator('#submit').click();
    await step();
    const marked = await cues(page);
    expect(marked['email']).toBe('outline:dashed');
    expect(marked['age']).toBe('outline:dashed');
    await page.locator('#email').fill('a@b.co');
    await page.locator('#age').fill('30');
    await step();
    const fixed = await cues(page);
    expect(fixed['email']).toBeUndefined();
    expect(fixed['age']).toBeUndefined();
  });

  test('the event bridge works only while cues are on: no work off, one set of work when on again', async () => {
    const { page, step, diag } = await load(ext, server, A11Y, SETTINGS);
    const type = async (value: string) => {
      await page.locator('#email').fill(value);
      await flushDynamic(ext.worker, page);
    };
    const before = (await diag()).semanticInvalidations;
    await type('a');
    expect((await diag()).semanticInvalidations - before).toBeGreaterThan(0);

    await setSettings(ext.worker, { ...SETTINGS, semanticCuesEnabled: false });
    await refresh(ext.worker, page);
    await step();
    const off = await diag();
    await type('ab');
    await type('abc');
    const stillOff = await diag();
    expect(stillOff.semanticInvalidations).toBe(off.semanticInvalidations);
    expect(stillOff.semantic.semanticPasses).toBe(off.semantic.semanticPasses);

    await setSettings(ext.worker, SETTINGS);
    await refresh(ext.worker, page);
    await step();
    const on = await diag();
    await page.locator('#email').fill('abcd');
    await page.locator('#email').dispatchEvent('input');
    await flushDynamic(ext.worker, page);
    const delta = (await diag()).semanticInvalidations - on.semanticInvalidations;
    // `fill` fires one input event, the dispatched one is a second: two, never doubled by a leaked listener.
    expect(delta).toBe(2);
  });
});

test.describe('M6.R1 default and settings in a real profile', () => {
  test('a fresh profile (nothing stored): the default is ON and the strongly evidenced cues appear', async () => {
    const fresh = await launchExtension();
    try {
      const page = await fresh.context.newPage();
      await page.goto(`${server.origin}/semantic.html`);
      await expect
        .poll(async () => (await dynamicDiagnostics(fresh.worker, page).catch(() => null))?.state)
        .toBe('IDLE');
      await flushDynamic(fresh.worker, page);
      await settle(page);
      await expectCues(page, INITIAL_CUES);
      const all = await cues(page);
      // safe high-confidence -> cue; medium, unknown, conflict, already accessible -> none
      for (const id of NEVER_CUED) expect(all[id], `#${id}`).toBeUndefined();

      // The stored value is what the page ran with: absent from storage, true in effect.
      const stored = await storedSettings(fresh.worker);
      expect(stored).toBeUndefined();
    } finally {
      await fresh.close();
    }
  });

  test('settings stored before M6 (no field) run with cues ON; an explicit false is honored and never overwritten', async () => {
    const withoutField = { enabled: true, visionProfile: 'deuteranopia', adaptationStrength: 1 };
    const open = async (settings: Record<string, unknown>) => {
      await setSettings(ext.worker, settings);
      const page = await ext.context.newPage();
      await page.goto(`${server.origin}/semantic.html`);
      await expect
        .poll(async () => (await dynamicDiagnostics(ext.worker, page).catch(() => null))?.state)
        .toBe('IDLE');
      await flushDynamic(ext.worker, page);
      await settle(page);
      return page;
    };

    let page = await open(withoutField);
    expect(Object.keys(await cues(page)).length).toBe(Object.keys(INITIAL_CUES).length);
    await page.close();

    for (let visit = 0; visit < 3; visit += 1) {
      page = await open({ ...withoutField, semanticCuesEnabled: false });
      expect(await cues(page), `visit ${visit}`).toEqual({});
      expect(await hasCueSheet(page)).toBe(false);
      await page.close();
    }
    const stored = await storedSettings(ext.worker);
    expect(stored?.['semanticCuesEnabled']).toBe(false);

    // A non-boolean is not "false by accident": it falls back to the default (documented).
    page = await open({ ...withoutField, semanticCuesEnabled: 'off' });
    expect(Object.keys(await cues(page)).length).toBe(Object.keys(INITIAL_CUES).length);
  });

  test('true -> false -> true x5: cues leave completely and come back as exactly one correct set', async () => {
    const { page, step, diag } = await load(ext, server, 'semantic.html', SETTINGS);
    const original = await pageStructure(page);
    const initial = await cues(page);
    for (let cycle = 0; cycle < 5; cycle += 1) {
      await setSettings(ext.worker, { ...SETTINGS, semanticCuesEnabled: false });
      await refresh(ext.worker, page);
      await step();
      expect(await cues(page), `off ${cycle}`).toEqual({});
      expect(await hasCueSheet(page)).toBe(false);
      expect(await pageStructure(page)).toBe(original);
      expect((await diag()).semantic.cuesActive).toBe(0);

      await setSettings(ext.worker, SETTINGS);
      await refresh(ext.worker, page);
      await step();
      expect(await cues(page), `on ${cycle}`).toEqual(initial);
      expect((await diag()).semantic.cuesActive).toBe(Object.keys(initial).length);
    }
  });
});

test.describe('M6.R1 next to M3 recoloring', () => {
  const FRAGMENT =
    '<span id="m3a" class="badge success" style="color:#c0392b;background-color:#27ae60">Order 8</span>' +
    '<span id="m3b" class="badge error" style="color:#c0392b;background-color:#2c3e50">Order 9</span>';

  /** `{ id: computed color }` of the two badges plus the number of ColorAdapt rules in the sheet. */
  const colors = (page: Page) =>
    page.evaluate(() => ({
      a: getComputedStyle(document.getElementById('m3a')!).color,
      b: getComputedStyle(document.getElementById('m3b')!).color,
      // rules in force: one per (element, declaration), a rule of the sheet being shared (M12.5)
      rules: [...document.querySelectorAll('[data-coloradapt-s]')].reduce(
        (sum, e) =>
          sum + (e.getAttribute('data-coloradapt-s') ?? '').split(' ').filter(Boolean).length,
        0,
      ),
    }));

  test('color-only + recolored: one cue per element, no duplicate adaptation, and OFF restores both', async () => {
    const { page, step, diag } = await load(ext, server, 'semantic.html', SETTINGS);
    await page.evaluate((html) => window.sem.add(html, 'badges'), FRAGMENT);
    await step();
    const adapted = await colors(page);
    expect(adapted.rules).toBeGreaterThan(0); // M3 recolored the conflicting text
    const now = await cues(page);
    expect(now['m3a']).toBe('after:2713');
    expect(now['m3b']).toBe('after:d7');
    const rulesAfterFirst = adapted.rules;

    // A refresh does not compound either channel: same rules, same cues, same counters of what was applied.
    const applied = (await diag()).semantic.cuesApplied;
    for (let i = 0; i < 3; i += 1) {
      await refresh(ext.worker, page);
      await step();
    }
    expect((await colors(page)).rules).toBe(rulesAfterFirst);
    expect((await cues(page))['m3a']).toBe('after:2713');
    expect((await diag()).semantic.cuesApplied).toBe(applied);
    expect((await diag()).semantic.cuesActive).toBe(Object.keys(INITIAL_CUES).length + 2);

    // OFF: the original colors, no cue, no sheet.
    await disable(ext.worker, page);
    await settle(page);
    const off = await colors(page);
    expect(off).toEqual({ a: 'rgb(192, 57, 43)', b: 'rgb(192, 57, 43)', rules: 0 });
    expect(await cues(page)).toEqual({});
    expect(await page.evaluate(() => document.getElementById('coloradapt-stylesheet'))).toBeNull();
  });
});
