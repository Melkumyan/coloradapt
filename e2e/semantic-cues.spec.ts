import { expect, test } from '@playwright/test';
import {
  disable,
  dynamicDiagnostics,
  enable,
  flushDynamic,
  launchExtension,
  refresh,
  settle,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';
import { diffCounters, expectNoWork, load } from './r1-kit';
import {
  INITIAL_CUES,
  NEVER_CUED,
  SETTINGS,
  accessibilityTree,
  boxes,
  cues,
  expectCues,
  hasCueSheet,
  openOff,
  pageStructure,
  pixels,
  pseudo,
  tabOrder,
  turnOn,
} from './semantic-kit';

/**
 * M6 in a real browser: what the cues look like, that they change nothing about how the page
 * works, that they leave when asked to, and that the page's accessibility tree is the same with
 * and without them. Everything reads the browser; nothing sleeps.
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

test.describe('M6 what gets a cue', () => {
  test('exactly the color-only, strongly evidenced states, and nothing else', async () => {
    const page = await openOff(ext, server);
    expect(await cues(page)).toEqual({});
    await turnOn(ext, page);
    await expectCues(page, INITIAL_CUES);
    // The false-positive set is part of the same page: red logo, yellow star, sale price, green
    // link, btn-danger, plain red text, words that already say it, ...
    const all = await cues(page);
    for (const id of NEVER_CUED) expect(all[id], `#${id} must not have a cue`).toBeUndefined();
  });

  test('the diagnostics add up: nothing planned was lost, nothing unplanned was applied', async () => {
    const { page, diag } = await load(ext, server, 'semantic.html', SETTINGS);
    const { semantic } = await diag();
    const expected = Object.keys(INITIAL_CUES).length;
    expect(semantic.cuesPlanned).toBe(expected);
    expect(semantic.cuesApplied).toBe(expected);
    expect(semantic.cuesNotApplied).toBe(0);
    expect(semantic.cuesActive).toBe(expected);
    expect(semantic.semanticConflicts).toBe(0);
    expect(semantic.colorOnlyDetected).toBeGreaterThanOrEqual(expected);
    await expectCues(page, INITIAL_CUES);
  });

  test('a lower confidence reaches no page: the setting off means no cue at all', async () => {
    const { page } = await load(ext, server, 'semantic.html', {
      ...SETTINGS,
      semanticCuesEnabled: false,
    });
    expect(await cues(page)).toEqual({});
    expect(await hasCueSheet(page)).toBe(false);
  });
});

test.describe('M6 what a cue looks like', () => {
  test('glyph cues: an ::after with an empty alternative text that cannot be clicked', async () => {
    const { page } = await load(ext, server, 'semantic.html', SETTINGS);
    // Text glyphs are drawn as text (all of them in the Latin-1 / WGL4 range every font has) ...
    for (const [id, glyph] of [
      ['b2', '×'],
      ['b3', '!'],
      ['al1', '×'],
      ['v1', '+'],
      ['v2', '−'],
      ['lbl-email', '*'],
      // ... except where the glyph is rare: the info sign is an ASCII "i" in a ring.
      ['al2', 'i'],
    ] as const) {
      const style = await pseudo(page, id);
      expect(style.content, `#${id}`).toContain(glyph);
      expect(style.content, `#${id}`).toMatch(/\/\s*""\s*$/);
      expect(style.pointerEvents, `#${id}`).toBe('none');
    }
    // The check mark is a shape: no text at all, an empty alternative text, a clip-path polygon.
    const check = await pseudo(page, 'b1');
    expect(check.content).toBe('"" / ""');
    expect(check.clipPath).toContain('polygon(');
    expect(check.display).toBe('inline-block');
    expect(check.pointerEvents).toBe('none');
    expect(Number.parseFloat(check.width)).toBeGreaterThan(5);
  });

  test("a text glyph takes the element's own text color in light and in dark mode", async () => {
    const { page } = await load(ext, server, 'semantic.html', SETTINGS);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await settle(page);
      for (const id of ['b1', 'al1', 'v1']) {
        const own = await page.evaluate(
          (target) => getComputedStyle(document.getElementById(target)!).color,
          id,
        );
        expect((await pseudo(page, id)).color, `#${id} (${scheme})`).toBe(own);
      }
    }
  });

  test('a dot gets its glyph inside the box, in a tone that reads against its fill', async () => {
    const { page } = await load(ext, server, 'semantic.html', SETTINGS);
    for (const id of ['d2', 'd3']) {
      const style = await pseudo(page, id);
      expect(style.display, `#${id}`).toBe('flex');
      expect(style.pointerEvents).toBe('none');
    }
    // The online check is a shape filling the dot's box, painted instead of colored.
    const check = await pseudo(page, 'd1');
    expect(check.display).toBe('block');
    expect(check.clipPath).toContain('polygon(');
    expect(check.pointerEvents).toBe('none');
    // Whichever of black / white has the higher WCAG contrast against the fill:
    // black on the mid-light green and the yellow, white on the darker red.
    expect((await pseudo(page, 'd1')).backgroundColor).toBe('rgb(0, 0, 0)');
    expect((await pseudo(page, 'd2')).color).toBe('rgb(255, 255, 255)');
    expect((await pseudo(page, 'd3')).color).toBe('rgb(0, 0, 0)');
  });

  test('a dot really looks different: the rendered pixels change, the layout does not', async () => {
    const page = await openOff(ext, server);
    const off = Object.fromEntries(
      await Promise.all(
        ['d1', 'd2', 'd3'].map(async (id) => [id, await pixels(page, id)] as const),
      ),
    );
    const boxesOff = await boxes(page, ['d1', 'd2', 'd3', 'people']);
    await turnOn(ext, page);
    for (const id of ['d1', 'd2', 'd3']) {
      expect(await pixels(page, id), `#${id} pixels`).not.toBe(off[id]);
    }
    expect(await boxes(page, ['d1', 'd2', 'd3', 'people'])).toEqual(boxesOff);
  });

  test('a selected tab is underlined, an unselected one is not', async () => {
    const { page } = await load(ext, server, 'semantic.html', SETTINGS);
    const read = (id: string) =>
      page.evaluate((target) => {
        const style = getComputedStyle(document.getElementById(target)!);
        return { line: style.textDecorationLine, thickness: style.textDecorationThickness };
      }, id);
    expect(await read('tab1')).toEqual({ line: 'underline', thickness: '2px' });
    expect((await read('tab2')).line).toBe('none');
    expect((await read('nav-home')).line).toBe('underline');
    expect((await read('nav-about')).line).toBe('none');
  });

  test('an invalid field gets a dashed outline, and the focus ring wins while it is focused', async () => {
    const { page, step } = await load(ext, server, 'semantic.html', SETTINGS);
    await page.locator('#email').focus();
    await page.keyboard.type('x');
    await step();
    await page.locator('#name').focus();
    await step();
    const outline = (id: string) =>
      page.evaluate((target) => {
        const style = getComputedStyle(document.getElementById(target)!);
        return { style: style.outlineStyle, width: style.outlineWidth };
      }, id);
    expect(await outline('email')).toEqual({ style: 'dashed', width: '2px' });
    expect((await outline('name')).style).not.toBe('dashed');

    await page.keyboard.press('Shift+Tab'); // back into the invalid field, by keyboard
    await step();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('email');
    expect((await outline('email')).style).toBe('auto');
  });
});

test.describe('M6 the page keeps working', () => {
  test('buttons, forms, links and typing behave exactly as before', async () => {
    const { page, step } = await load(ext, server, 'semantic.html', SETTINGS);

    await page.locator('#delete').click();
    await page.locator('#save').click();
    expect(await page.evaluate(() => window.counters)).toMatchObject({
      del: 1,
      save: 1,
      submitted: 1,
    });

    await page.locator('#name').fill('Alice');
    expect(await page.locator('#name').inputValue()).toBe('Alice');
    await page.locator('#email').fill('alice@example.com');
    await step();
    expect(await page.locator('#email').inputValue()).toBe('alice@example.com');

    await page.locator('#tab2').click();
    expect(await page.locator('#tab2').getAttribute('aria-selected')).toBe('true');

    await Promise.all([page.waitForURL('**/basic.html'), page.locator('#docs-link').click()]);
    expect(page.url()).toMatch(/\/basic\.html$/);
  });

  test('the keyboard path is the same: one tab stop per control, no new ones, no stolen focus', async () => {
    const plain = await openOff(ext, server);
    const before = await tabOrder(plain);
    await plain.close();
    const page = await openOff(ext, server);
    await turnOn(ext, page);
    const after = await tabOrder(page);
    expect(after).toEqual(before);
    // A cue host that was not focusable is still not focusable.
    const focusable = await page.evaluate(() =>
      [...document.querySelectorAll('[data-coloradapt-cue]')]
        .filter((el) => el.hasAttribute('tabindex'))
        .map((el) => el.id),
    );
    expect(focusable).toEqual([]);

    // Enter on a focused tab still activates it.
    await page.locator('#tab3').focus();
    await page.keyboard.press('Enter');
    expect(await page.locator('#tab3').getAttribute('aria-selected')).toBe('true');
  });

  test('a cue does not intercept the pointer: clicking where a glyph is reaches the element', async () => {
    const { page } = await load(ext, server, 'semantic.html', SETTINGS);
    await page.evaluate(() => {
      document.getElementById('b1')!.addEventListener('click', () => {
        (window as unknown as { b1Clicks: number }).b1Clicks =
          ((window as unknown as { b1Clicks?: number }).b1Clicks ?? 0) + 1;
      });
    });
    const box = await page.locator('#b1').boundingBox();
    // The right edge of the badge is where the glyph is drawn.
    await page.mouse.click(box!.x + box!.width - 4, box!.y + box!.height / 2);
    expect(await page.evaluate(() => (window as unknown as { b1Clicks: number }).b1Clicks)).toBe(1);
    expect(
      await page.evaluate(
        ([x, y]) => document.elementFromPoint(x!, y!)?.id,
        [box!.x + box!.width - 4, box!.y + box!.height / 2],
      ),
    ).toBe('b1');
  });
});

test.describe('M6 layout', () => {
  test('boxes do not move or resize; inline glyphs only extend the line they sit on', async () => {
    const page = await openOff(ext, server);
    const still = [
      'd1',
      'd2',
      'd3',
      'tab1',
      'tab2',
      'nav-home',
      'lbl-email',
      'al1',
      'al2',
      'email',
      'name',
    ];
    const inline = ['b1', 'b2', 'b3', 'v1', 'v2'];
    const before = await boxes(page, [...still, ...inline]);
    await turnOn(ext, page);
    const after = await boxes(page, [...still, ...inline]);

    for (const id of still) expect(after[id], `#${id}`).toEqual(before[id]);
    for (const id of inline) {
      expect(after[id]!.y, `#${id} y`).toBe(before[id]!.y);
      expect(after[id]!.height, `#${id} height`).toBe(before[id]!.height);
      // A glyph and its margin: well under 2em of 16px text.
      expect(after[id]!.width - before[id]!.width, `#${id} growth`).toBeGreaterThan(0);
      expect(after[id]!.width - before[id]!.width, `#${id} growth`).toBeLessThan(24);
    }
  });
});

test.describe('M6 screen-reader surface', () => {
  test('the accessibility tree is identical with and without cues', async () => {
    const page = await openOff(ext, server);
    const before = await accessibilityTree(page);
    await turnOn(ext, page);
    expect(Object.keys(await cues(page)).length).toBe(Object.keys(INITIAL_CUES).length);
    expect(await accessibilityTree(page)).toBe(before);
  });

  test('cue hosts keep their accessible names: no glyph leaks into them', async () => {
    const page = await openOff(ext, server);
    const names = (ids: string[]) =>
      page.evaluate(
        (list) =>
          list.map((id) => {
            const el = document.getElementById(id)!;
            return `${id}:${el.getAttribute('aria-label') ?? ''}:${el.textContent}`;
          }),
        ids,
      );
    const ids = ['b1', 'b2', 'al1', 'tab1', 'lbl-email', 'v1', 'd1'];
    const before = await names(ids);
    await turnOn(ext, page);
    expect(await names(ids)).toEqual(before);
  });
});

test.describe('M6 reversibility and idempotency', () => {
  test('ON/OFF x10: OFF restores the page exactly, ON brings the same cues back', async () => {
    const page = await openOff(ext, server);
    const original = await pageStructure(page);
    await turnOn(ext, page);

    for (let cycle = 0; cycle < 10; cycle += 1) {
      await disable(ext.worker, page);
      await settle(page);
      expect(await cues(page), `cycle ${cycle}`).toEqual({});
      expect(await hasCueSheet(page), `cycle ${cycle}`).toBe(false);
      expect(
        await page.evaluate(() => document.getElementById('coloradapt-stylesheet')),
      ).toBeNull();
      expect(await pageStructure(page), `cycle ${cycle}`).toBe(original);

      await enable(ext.worker, page);
      await settle(page);
      await expectCues(page, INITIAL_CUES);
    }
  });

  test('refresh x5: the same cues, never a second one', async () => {
    const { page, diag } = await load(ext, server, 'semantic.html', SETTINGS);
    const first = await cues(page);
    const applied = (await diag()).semantic.cuesApplied;
    for (let i = 0; i < 5; i += 1) {
      await refresh(ext.worker, page);
      await settle(page);
    }
    expect(await cues(page)).toEqual(first);
    const after = (await diag()).semantic;
    expect(after.cuesActive).toBe(Object.keys(first).length);
    expect(after.cuesApplied).toBe(applied);
    // One rule per cue *kind*: 13 cues, fewer rules.
    const rules = await page.evaluate(
      () =>
        (
          document
            .getElementById('coloradapt-stylesheet')
            ?.textContent.match(/\[data-coloradapt-cue="[^"]+"\]\{/g) ?? []
        ).length,
    );
    expect(rules).toBeLessThan(Object.keys(first).length);
  });
});

test.describe('M6 no feedback loop', () => {
  test("once settled the page does no work: cue writes are ColorAdapt's own mutations", async () => {
    const { page, step, diag } = await load(ext, server, 'semantic.html', SETTINGS);
    await step();
    // Let the real scheduler and observer run for a few frames: nothing may be queued by our own cues.
    for (let i = 0; i < 4; i += 1) await settle(page);
    const settled = await diag();
    for (let i = 0; i < 4; i += 1) await settle(page);
    const now = await dynamicDiagnostics(ext.worker, page);
    const delta = diffCounters(now, settled);
    expectNoWork(delta);
    expect(delta.batches).toBe(0);
    expect(now.semantic.semanticPasses).toBe(settled.semantic.semanticPasses);
    expect(now.queuedRecords).toBe(0);
    expect(now.state).toBe('IDLE');
    expect((await flushDynamic(ext.worker, page)).semantic.cuesApplied).toBe(
      settled.semantic.cuesApplied,
    );
  });
});
