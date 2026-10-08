import { expect, test } from '@playwright/test';
import {
  launchExtension,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';
import { load } from './r1-kit';
import { INITIAL_CUES, SETTINGS, cues, expectCues } from './semantic-kit';

/**
 * M6 through the M4 pipeline in a real browser: state that changes after load (SPA tab
 * clicks, JS validation, native form validity, inserted and removed nodes, class and text
 * changes) updates its cue in one incremental pass, leaves no stale cue, and never needs a
 * full rescan. Counters are structural; nothing sleeps.
 */
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

const open = () => load(ext, server, 'semantic.html', SETTINGS);

test.describe('M6 SPA state changes', () => {
  test('clicking tabs moves the underline: one incremental pass per click, no stale cue', async () => {
    const { page, step } = await open();
    await step();

    for (const next of ['tab2', 'tab3', 'tab1']) {
      await page.locator(`#${next}`).click();
      const delta = await step();
      const now = await cues(page);
      const underlined = Object.keys(now).filter(
        (id) => now[id] === 'underline' && id.startsWith('tab'),
      );
      expect(underlined, `after clicking #${next}`).toEqual([next]);
      expect(delta.incrementalPasses).toBe(1);
      expect(delta.fullRescans).toBe(0);
    }
    await expectCues(page, INITIAL_CUES);
  });

  test('JS validation: aria-invalid on the field draws the outline; fixing it removes it', async () => {
    const { page, step } = await open();
    await page.locator('#email').focus();
    await page.keyboard.type('nope');
    let delta = await step();
    expect((await cues(page)).email).toBe('outline:dashed');
    expect(delta.fullRescans).toBe(0);

    await page.keyboard.type('@example.com');
    delta = await step();
    expect((await cues(page)).email).toBeUndefined();
    expect(delta.fullRescans).toBe(0);
  });

  test('class success -> error: the glyph is replaced; back to a neutral class: it is gone', async () => {
    const { page, step } = await open();
    await page.evaluate(() => window.sem.setClass('b1', 'badge error'));
    await step();
    expect((await cues(page)).b1).toBe('after:d7');

    await page.evaluate(() => window.sem.setClass('b1', 'badge'));
    await step();
    expect((await cues(page)).b1).toBeUndefined();

    await page.evaluate(() => window.sem.setClass('b1', 'badge success'));
    await step();
    expect((await cues(page)).b1).toBe('after:2713');
  });

  test("online -> offline: the dot's glyph follows", async () => {
    const { page, step } = await open();
    await page.evaluate(() => window.sem.setClass('d1', 'status offline'));
    await step();
    expect((await cues(page)).d1).toMatch(/^inner:d7:/);
    await page.evaluate(() => window.sem.setClass('d1', 'status online'));
    await step();
    expect((await cues(page)).d1).toMatch(/^inner:2713:/);
  });

  test('a status dot inserted later gets a cue; removing it leaves nothing behind', async () => {
    const { page, step, diag } = await open();
    await page.evaluate(() =>
      window.sem.add('<li><span id="dn" class="status offline"></span>Dave</li>'),
    );
    await step();
    expect((await cues(page)).dn).toMatch(/^inner:d7:/);

    await page.evaluate(() => window.sem.remove('dn'));
    await step();
    expect((await cues(page)).dn).toBeUndefined();
    expect((await diag()).semantic.cuesActive).toBe(Object.keys(INITIAL_CUES).length);
  });

  test('a dot whose shape differs from its peers is left alone', async () => {
    const { page, step } = await open();
    await page.evaluate(() =>
      window.sem.add('<li><span id="dsq" class="status offline sq"></span>Eve</li>'),
    );
    await step();
    // The square one is told apart from the online / warning dots by shape already. The round
    // offline dot is not (it has the same shape as the others), so it keeps its glyph.
    const now = await cues(page);
    expect(now.dsq).toBeUndefined();
    expect(now.d2).toMatch(/^inner:d7:/);
  });

  test('state text: "Order 1" -> "Failed" contradicts the class (a conflict: no cue), and back', async () => {
    const { page, step, diag } = await open();
    await page.evaluate(() => window.sem.setText('b1', 'Failed'));
    await step();
    expect((await cues(page)).b1).toBeUndefined();
    expect((await diag()).semantic.semanticConflicts).toBeGreaterThan(0);

    await page.evaluate(() => window.sem.setText('b1', 'Order 1'));
    await step();
    expect((await cues(page)).b1).toBe('after:2713');
  });

  test('state text that now says it: "Order 2" -> "Error" needs no cue any more', async () => {
    const { page, step } = await open();
    expect((await cues(page)).b2).toBe('after:d7');
    await page.evaluate(() => window.sem.setText('b2', 'Error'));
    await step();
    expect((await cues(page)).b2).toBeUndefined();
  });
});

test.describe('M6 observed attributes', () => {
  test('title / aria-label changes are delivered (one cheap pass); other attributes still are not', async () => {
    const { page, step } = await open();
    await step();

    await page.evaluate(() => {
      const el = document.getElementById('logo')!;
      el.setAttribute('title', 'Home');
      el.setAttribute('aria-label', 'ACME home');
    });
    const delivered = await step();
    expect(delivered.incrementalPasses).toBe(1);
    expect(delivered.fullRescans).toBe(0);
    expect(delivered.affectedRoots).toBe(1);

    await page.evaluate(() => {
      const el = document.getElementById('logo')!;
      el.setAttribute('data-anything', '1');
      el.setAttribute('tabindex', '0');
      el.setAttribute('aria-hidden', 'false');
    });
    const ignored = await step();
    expect(ignored.mutationRecords).toBe(0);
    expect(ignored.incrementalPasses).toBe(0);
  });

  test('an accessible name that now says it does not make a color-only claim', async () => {
    const { page, step } = await open();
    // "Failed" in the accessible name of a plain red logo: a LOW-confidence word, never a cue.
    await page.evaluate(() =>
      document.getElementById('logo')!.setAttribute('aria-label', 'Failed'),
    );
    await step();
    expect((await cues(page)).logo).toBeUndefined();
  });
});

test.describe('M6 native form validity', () => {
  test('typing an invalid email into a native field draws the cue, with no DOM mutation at all', async () => {
    const { page, step, diag } = await open();
    await step();
    const before = await diag();
    expect((await cues(page)).nemail).toBeUndefined(); // untouched and required: no cue

    await page.locator('#nemail').focus();
    await page.keyboard.type('not-an-email');
    await page.keyboard.press('Tab'); // leaving the field: `:user-invalid` now matches
    const delta = await step();

    expect((await cues(page)).nemail).toBe('outline:dashed');
    expect(delta.semanticInvalidations).toBeGreaterThan(0);
    // The only thing that woke the pipeline was the form event, and a burst of keystrokes is a few passes at most.
    expect(delta.fullRescans).toBe(0);
    expect((await diag()).semanticInvalidations).toBeGreaterThan(before.semanticInvalidations);

    await page.locator('#nemail').fill('a@b.co');
    await step();
    expect((await cues(page)).nemail).toBeUndefined();
  });

  test("submitting an invalid native form: the browser's own invalid event marks the fields", async () => {
    const { page, step } = await open();
    await page.locator('#nemail').focus();
    await page.keyboard.type('x');
    await page
      .locator('#nemail')
      .evaluate((el) => (el.closest('form') as HTMLFormElement).requestSubmit());
    await step();
    expect((await cues(page)).nemail).toBe('outline:dashed');
    expect(await page.evaluate(() => window.counters.nativeSubmitted)).toBe(0); // blocked by validation
  });
});

test.describe('M6 budgets and batching', () => {
  test('100 status rows flipping in one batch: one incremental pass, no full rescan', async () => {
    const { page, step } = await open();
    await page.evaluate(() => window.sem.rows(100, 'online'));
    let delta = await step();
    expect(delta.fullRescans).toBe(0);
    const initial = await cues(page);
    expect(Object.keys(initial).filter((id) => id.startsWith('r')).length).toBe(100);

    await page.evaluate(() => window.sem.flipRows('offline'));
    delta = await step();
    expect(delta.batches).toBe(1);
    expect(delta.incrementalPasses).toBe(1);
    expect(delta.fullRescans).toBe(0);
    const flipped = await cues(page);
    const rows = Object.entries(flipped).filter(([id]) => id.startsWith('r'));
    expect(rows.length).toBe(100);
    for (const [, key] of rows) expect(key).toMatch(/^inner:d7:/);
  });

  test('removing 100 rows: no cue is left behind', async () => {
    const { page, step, diag } = await open();
    await page.evaluate(() => window.sem.rows(100, 'online'));
    await step();
    await page.evaluate(() => (document.getElementById('rows')!.innerHTML = ''));
    await step();
    expect((await diag()).semantic.cuesActive).toBe(Object.keys(INITIAL_CUES).length);
  });
});

test.describe('M6 next to M3', () => {
  test('a recolored element still gets its second channel', async () => {
    const { page, step, diag } = await open();
    await page.evaluate(() =>
      window.sem.add(
        '<span id="m3a" class="badge success" style="color:#c0392b;background-color:#27ae60">Order 8</span>' +
          '<span id="m3b" class="badge error" style="color:#c0392b;background-color:#2c3e50">Order 9</span>',
        'badges',
      ),
    );
    await step();
    const now = await cues(page);
    expect(now.m3a).toBe('after:2713');
    expect(now.m3b).toBe('after:d7');
    // M3 did recolor the conflicting one: the two channels are independent.
    const adapted = await page.evaluate(() => {
      const tokens = document.getElementById('m3a')!.getAttribute('data-coloradapt-s') ?? '';
      const text = document.getElementById('coloradapt-stylesheet')?.textContent ?? '';
      return tokens
        .split(' ')
        .some((t) => t !== '' && text.includes(`[data-coloradapt-s~="${t}"]`));
    });
    expect(adapted).toBe(true);
    expect((await diag()).rules).toBeGreaterThan(0);
  });
});
