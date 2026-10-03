import { expect, test } from '@playwright/test';
import {
  computedColors,
  launchExtension,
  refresh,
  settle,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';
import {
  expectConsistent,
  expectEquivalentToFullRescan,
  expectNoWork,
  load,
  ORIGINAL_BAD,
  rule,
  ruleTotal,
} from './r1-kit';

/**
 * M4.R1 sections A-E, real Chromium: node insertion forms, attribute churn,
 * net-zero batches, text mutations and theme switches. Every case asserts the
 * browser's computed colors and the pipeline's structural counters; the
 * forced flush (`FLUSH_DYNAMIC`) stands in for the scheduler, and nothing
 * sleeps.
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

const open = () => load(ext, server);

test.describe('R1-A. node insertion', () => {
  interface Case {
    readonly kind: string;
    /** Candidate elements the analyzer inspects for the inserted content. */
    readonly candidates: number;
    readonly roots: number;
    /** Rules the insertion adds (conflicting elements only). */
    readonly rules: number;
    /** Existing rules the operation removes (content it replaced). */
    readonly removed?: number;
  }
  const CASES: readonly Case[] = [
    { kind: 'appendChild', candidates: 1, roots: 1, rules: 1 },
    { kind: 'prepend', candidates: 1, roots: 1, rules: 1 },
    { kind: 'insertBefore', candidates: 1, roots: 1, rules: 1 },
    { kind: 'insertAdjacentHTML', candidates: 4, roots: 4, rules: 4 },
    { kind: 'replaceWith', candidates: 1, roots: 1, rules: 1 },
    { kind: 'replaceChildren', candidates: 3, roots: 3, rules: 3, removed: 5 },
    { kind: 'fragment', candidates: 5, roots: 5, rules: 5 },
    { kind: 'nested', candidates: 3, roots: 1, rules: 3 },
    { kind: 'cloneNode', candidates: 1, roots: 1, rules: 1 },
    { kind: 'cloneNode-subtree', candidates: 3, roots: 1, rules: 3 },
  ];

  for (const c of CASES) {
    test(`${c.kind}: adapted by one incremental pass over the new region only`, async () => {
      const { page, step, diag } = await open();
      // An existing, adapted neighbour and anchors: none of them may be re-analyzed.
      await page.evaluate(() => {
        const app = document.getElementById('app')!;
        app.insertAdjacentHTML(
          'beforeend',
          '<span id="anchor" class="good">Anchor</span><p id="neighbour" class="bad">Neighbour</p>',
        );
        const nest = document.createElement('section');
        nest.id = 'nest-src';
        nest.innerHTML =
          '<ul><li id="n1" class="bad">One</li><li id="n2" class="bad">Two</li></ul><p id="n3" class="bad">Three</p>';
        app.append(nest);
        app.append(window.rows('src', 1));
      });
      await step();
      const neighbourBefore = (await computedColors(page, ['neighbour']))['neighbour'];
      const rulesBefore = await ruleTotal(page);
      const trackedBefore = (await diag()).trackedElements;

      await page.evaluate((kind) => {
        const app = document.getElementById('app')!;
        const anchor = document.getElementById('anchor')!;
        const row = (id: string) => {
          const el = window.rows(id, 1).firstElementChild as HTMLElement;
          el.id = id;
          return el;
        };
        switch (kind) {
          case 'appendChild':
            app.appendChild(row('t0'));
            break;
          case 'prepend':
            app.prepend(row('t0'));
            break;
          case 'insertBefore':
            app.insertBefore(row('t0'), anchor);
            break;
          case 'insertAdjacentHTML':
            anchor.insertAdjacentHTML('beforebegin', '<p id="t0" class="bad">a</p>');
            anchor.insertAdjacentHTML('afterend', '<p id="t1" class="bad">b</p>');
            app.insertAdjacentHTML('afterbegin', '<p id="t2" class="bad">c</p>');
            app.insertAdjacentHTML('beforeend', '<p id="t3" class="bad">d</p>');
            break;
          case 'replaceWith':
            anchor.replaceWith(row('t0'));
            break;
          case 'replaceChildren':
            app.replaceChildren(window.rows('t', 3));
            break;
          case 'fragment':
            app.append(window.rows('t', 5));
            break;
          case 'nested': {
            const root = document.createElement('div');
            root.innerHTML =
              '<section><ul><li id="t0" class="bad">x</li><li id="t1" class="bad">y</li></ul><p id="t2" class="bad">z</p></section>';
            app.append(root);
            break;
          }
          case 'cloneNode': {
            const clone = document.getElementById('src0')!.cloneNode(true) as HTMLElement;
            clone.id = 't0';
            app.append(clone);
            break;
          }
          case 'cloneNode-subtree': {
            const clone = document.getElementById('nest-src')!.cloneNode(true) as HTMLElement;
            clone.id = 'nest-clone';
            for (const [i, el] of [...clone.querySelectorAll('[id]')].entries()) el.id = `t${i}`;
            app.append(clone);
            break;
          }
        }
      }, c.kind);
      const delta = await step();

      expect(delta.incrementalPasses).toBe(1);
      expect(delta.fullRescans).toBe(0);
      expect(delta.affectedRoots).toBe(c.roots);
      expect(delta.elementsProcessed).toBe(c.candidates);
      expect(delta.rulesAdded).toBe(c.rules);
      expect(delta.rulesUpdated).toBe(0);
      if (c.kind !== 'replaceChildren') {
        expect((await computedColors(page, ['neighbour']))['neighbour']).toBe(neighbourBefore);
      }
      expect(await rule(page, 't0')).toBe(true);
      const after = await diag();
      expect(delta.rulesRemoved).toBe(c.removed ?? 0);
      expect(await ruleTotal(page)).toBe(rulesBefore + c.rules - (c.removed ?? 0));
      expect(after.rules).toBe(rulesBefore + c.rules - (c.removed ?? 0));
      if (c.kind !== 'replaceChildren' && c.kind !== 'replaceWith') {
        expect(after.trackedElements).toBeGreaterThanOrEqual(trackedBefore + c.rules);
      }
      await expectConsistent(page);

      // Stable once the observer has settled: further frames do no work.
      await settle(page);
      await settle(page);
      const later = await diag();
      expect(later.incrementalPasses).toBe(after.incrementalPasses);
      expect(later.fullRescans).toBe(0);
      expect(later.state).toBe('IDLE');
      expect(later.queuedRecords).toBe(0);
      expect(later.deferredRoots).toBe(0);

      await expectEquivalentToFullRescan(ext, page);
    });
  }

  test('cloneNode copies the id attribute but never shares a rule or an id', async () => {
    const { page, step } = await open();
    await page.evaluate(() => document.getElementById('app')!.append(window.rows('orig', 1)));
    await step();
    const origId = await page.evaluate(() =>
      document.getElementById('orig0')!.getAttribute('data-coloradapt-id'),
    );
    await page.evaluate(() => {
      const clone = document.getElementById('orig0')!.cloneNode(true) as HTMLElement;
      clone.id = 'clone0';
      document.getElementById('app')!.append(clone);
    });
    await step();
    const ids = await page.evaluate(() => [
      document.getElementById('orig0')!.getAttribute('data-coloradapt-id'),
      document.getElementById('clone0')!.getAttribute('data-coloradapt-id'),
    ]);
    expect(ids[0]).toBe(origId);
    expect(ids[1]).not.toBe(ids[0]);
    expect(await rule(page, 'orig0')).toBe(true);
    expect(await rule(page, 'clone0')).toBe(true);
    await expectConsistent(page);

    // Removing the clone leaves the original's rule alone.
    await page.evaluate(() => document.getElementById('clone0')!.remove());
    const delta = await step();
    expect(delta.rulesRemoved).toBe(1);
    expect(await rule(page, 'orig0')).toBe(true);
    await expectConsistent(page);
  });
});

test.describe('R1-B. attribute churn', () => {
  test('relevant attributes trigger exactly one pass over the target subtree', async () => {
    const { page, step } = await open();
    const relevant: Array<[string, string]> = [
      ['class', "document.getElementById('static').className = 'good'"],
      ['class-back', "document.getElementById('static').className = 'bad'"],
      ['style', "document.getElementById('static').style.backgroundColor = '#ffffff'"],
      ['style-back', "document.getElementById('static').style.backgroundColor = ''"],
      ['hidden', "document.getElementById('static').hidden = true"],
      ['hidden-back', "document.getElementById('static').hidden = false"],
      ['disabled', "document.getElementById('btn').disabled = true"],
      ['disabled-back', "document.getElementById('btn').disabled = false"],
      ['aria-disabled', "document.getElementById('btn').setAttribute('aria-disabled', 'true')"],
      ['aria-disabled-back', "document.getElementById('btn').removeAttribute('aria-disabled')"],
      ['role', "document.getElementById('static').setAttribute('role', 'status')"],
      ['role-back', "document.getElementById('static').removeAttribute('role')"],
    ];
    for (const [name, code] of relevant) {
      await page.evaluate(code);
      const delta = await step();
      expect(delta.incrementalPasses, name).toBe(1);
      expect(delta.fullRescans, name).toBe(0);
      expect(delta.affectedRoots, name).toBe(1);
      expect(delta.elementsProcessed, name).toBe(1);
    }
    expect(await rule(page, 'static')).toBe(true);
    expect(await rule(page, 'btn')).toBe(true);
    await expectConsistent(page);
    await expectEquivalentToFullRescan(ext, page);
  });

  test('a parent attribute re-analyzes the parent subtree exactly once', async () => {
    const { page, step } = await open();
    await page.evaluate(() => (document.getElementById('parent')!.className = 'bg-green'));
    const delta = await step();
    expect(delta.incrementalPasses).toBe(1);
    expect(delta.affectedRoots).toBe(1);
    expect(delta.elementsProcessed).toBe(1); // #child
    expect(delta.rulesAdded).toBe(1);
  });

  test('irrelevant attributes are never delivered, and style churn is classified away', async () => {
    const { page, step } = await open();
    const rules = await ruleTotal(page);

    // Never delivered: not in the observer's attributeFilter.
    await page.evaluate(() => {
      const el = document.getElementById('static')!;
      // (M6: `title`, `aria-label` and the state-carrying data-* are delivered now, as SEMANTIC_CHANGE;
      // see semantic-dynamic.spec.ts. Everything below still is not.)
      el.setAttribute('lang', 'en');
      el.setAttribute('name', 'n');
      el.setAttribute('data-foo', '1');
      el.setAttribute('data-react-state', 'x');
      el.setAttribute('aria-hidden', 'false');
      el.setAttribute('tabindex', '0');
      const input = document.createElement('input');
      document.getElementById('app')!.append(input);
      input.value = 'typed';
      input.setAttribute('value', 'attr');
      el.dataset['counter'] = '1';
    });
    // The appended <input> is a real insertion (one root); everything else is not seen at all.
    const first = await step();
    expect(first.mutationRecords - first.selfMutationsIgnored).toBe(1);
    expect(first.irrelevantMutations).toBe(0);
    expect(first.affectedRoots).toBe(1);

    // Delivered, but classified irrelevant: layout/animation-only inline styles.
    await page.evaluate(() => {
      const el = document.getElementById('static')!;
      el.style.transform = 'translateX(3px)';
      el.style.transform = 'translateX(9px)';
      el.style.top = '1px';
      el.style.left = '2px';
      el.style.position = 'relative';
      el.style.width = '120px';
      el.style.zIndex = '3';
    });
    const style = await step();
    expect(style.mutationRecords).toBeGreaterThan(0);
    expect(style.irrelevantMutations).toBeGreaterThan(0);
    expectNoWork(style);

    // A transform written every frame stays free.
    for (let frame = 0; frame < 20; frame += 1) {
      await page.evaluate((n) => {
        document.getElementById('static')!.style.transform = `translateX(${n}px)`;
      }, frame);
    }
    expectNoWork(await step());
    expect(await ruleTotal(page)).toBe(rules);
    await expectConsistent(page);
  });
});

test.describe('R1-C. net-zero mutations inside one batch', () => {
  const NET_ZERO: Array<[string, string]> = [
    [
      'class A -> B -> C -> A',
      `const e = document.getElementById('static'); e.className = 'good'; e.className = 'red'; e.className = 'bad';`,
    ],
    [
      'class A -> B -> A',
      `const e = document.getElementById('static'); e.className = 'good'; e.className = 'bad';`,
    ],
    [
      'class token toggled off and on',
      `const e = document.getElementById('static'); e.classList.remove('bad'); e.classList.add('bad');`,
    ],
    [
      'hidden add -> remove',
      `const e = document.getElementById('static'); e.setAttribute('hidden', ''); e.removeAttribute('hidden');`,
    ],
    [
      'disabled add -> remove',
      `const e = document.getElementById('btn'); e.setAttribute('disabled', ''); e.removeAttribute('disabled');`,
    ],
    [
      'role add -> remove',
      `const e = document.getElementById('static'); e.setAttribute('role', 'status'); e.removeAttribute('role');`,
    ],
    [
      'inline style on -> off',
      `const e = document.getElementById('static'); e.style.backgroundColor = '#fff'; e.style.backgroundColor = '';`,
    ],
  ];

  for (const [name, code] of NET_ZERO) {
    test(`${name}: delivered, judged on the net change, no analysis`, async () => {
      const { page, step } = await open();
      await page.evaluate(code);
      const delta = await step();
      expect(delta.mutationRecords).toBeGreaterThanOrEqual(2);
      expect(delta.irrelevantMutations).toBeGreaterThanOrEqual(1);
      expectNoWork(delta);
      expect(await rule(page, 'static')).toBe(true);
    });
  }

  test('inline style X -> Y -> X (an existing relevant declaration) is no change', async () => {
    const { page, step } = await open();
    await page.evaluate(
      () => (document.getElementById('static')!.style.backgroundColor = 'rgb(39, 174, 96)'),
    );
    await step();
    await page.evaluate(() => {
      const e = document.getElementById('static')!;
      e.style.backgroundColor = '#ffffff';
      e.style.backgroundColor = '#000000';
      e.style.backgroundColor = 'rgb(39, 174, 96)';
    });
    const delta = await step();
    expect(delta.mutationRecords).toBeGreaterThanOrEqual(3);
    expectNoWork(delta);
  });

  test('text non-empty -> changed -> original, and non-empty -> empty -> original', async () => {
    const { page, step } = await open();
    await page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'tx';
      p.className = 'bad';
      p.append(document.createTextNode('hello'));
      document.getElementById('app')!.append(p);
    });
    await step();
    expect(await rule(page, 'tx')).toBe(true);

    await page.evaluate(() => {
      const t = document.getElementById('tx')!.firstChild as Text;
      t.data = 'changed';
      t.data = 'hello';
    });
    expectNoWork(await step());

    await page.evaluate(() => {
      const t = document.getElementById('tx')!.firstChild as Text;
      t.data = '';
      t.data = 'hello';
    });
    expectNoWork(await step());
    expect(await rule(page, 'tx')).toBe(true);
  });

  test('a net-zero batch alongside one real change costs exactly the real change', async () => {
    const { page, step } = await open();
    await page.evaluate(() => {
      const e = document.getElementById('static')!;
      e.className = 'good';
      e.className = 'red';
      e.className = 'bad'; // net zero
      document.getElementById('btn')!.className = 'good'; // real
    });
    const delta = await step();
    expect(delta.incrementalPasses).toBe(1);
    expect(delta.affectedRoots).toBe(1);
    expect(delta.elementsProcessed).toBe(1);
    expect(delta.rulesRemoved).toBe(1);
  });
});

test.describe('R1-D. text mutations', () => {
  test('empty <-> non-empty transitions trigger; non-empty -> different does not', async () => {
    const { page, step } = await open();
    await page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'tx';
      p.className = 'bad';
      p.append(document.createTextNode(''));
      document.getElementById('app')!.append(p);
    });
    const inserted = await step();
    expect(inserted.elementsProcessed).toBe(1);
    expect(await rule(page, 'tx')).toBe(false); // no own text yet: not adapted

    await page.evaluate(
      () => ((document.getElementById('tx')!.firstChild as Text).nodeValue = 'Hello'),
    );
    const filled = await step();
    expect(filled.incrementalPasses).toBe(1);
    expect(filled.elementsProcessed).toBe(1);
    expect(filled.rulesAdded).toBe(1);
    expect(await rule(page, 'tx')).toBe(true);

    await page.evaluate(
      () => ((document.getElementById('tx')!.firstChild as Text).nodeValue = 'Hello, again'),
    );
    const different = await step();
    expect(different.mutationRecords).toBeGreaterThan(0);
    expectNoWork(different);
    expect(await rule(page, 'tx')).toBe(true);

    await page.evaluate(() => ((document.getElementById('tx')!.firstChild as Text).nodeValue = ''));
    const emptied = await step();
    expect(emptied.incrementalPasses).toBe(1);
    expect(emptied.rulesRemoved).toBe(1);
    expect(await rule(page, 'tx')).toBe(false);

    // whitespace-only is still "no text"
    await page.evaluate(
      () => ((document.getElementById('tx')!.firstChild as Text).nodeValue = '   '),
    );
    expectNoWork(await step());
    await expectConsistent(page);
    await expectEquivalentToFullRescan(ext, page);
  });

  test('React-like in-place counter updates cost no pass at all', async () => {
    const { page, step } = await open();
    await page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'tick';
      p.className = 'bad';
      p.append(document.createTextNode('0'));
      document.getElementById('app')!.append(p);
    });
    await step();
    for (let round = 0; round < 10; round += 1) {
      await page.evaluate((r) => {
        const t = document.getElementById('tick')!.firstChild as Text;
        for (let i = 1; i <= 50; i += 1) t.data = String(r * 50 + i);
      }, round);
    }
    const delta = await step();
    expect(delta.mutationRecords).toBe(500);
    expect(delta.batches).toBeLessThanOrEqual(10);
    expectNoWork(delta);
    expect(await rule(page, 'tick')).toBe(true);
  });

  test('textContent replacement is a childList mutation: one self-root pass, by contract', async () => {
    const { page, step } = await open();
    await page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'tc';
      p.className = 'bad';
      p.textContent = 'one';
      document.getElementById('app')!.append(p);
    });
    await step();
    await page.evaluate(() => (document.getElementById('tc')!.textContent = ''));
    const cleared = await step();
    expect(cleared.incrementalPasses).toBe(1);
    expect(cleared.elementsProcessed).toBe(1);
    expect(await rule(page, 'tc')).toBe(false);
    await page.evaluate(() => (document.getElementById('tc')!.textContent = 'two'));
    const filled = await step();
    expect(filled.incrementalPasses).toBe(1);
    expect(filled.elementsProcessed).toBe(1);
    expect(await rule(page, 'tc')).toBe(true);
    await expectEquivalentToFullRescan(ext, page);
  });

  test('text in a script/template/style-free subtree never wakes the analyzer', async () => {
    const { page, step } = await open();
    await page.evaluate(() => {
      const s = document.createElement('script');
      s.type = 'application/json';
      s.textContent = '{"a":1}';
      document.getElementById('app')!.append(s);
      const t = document.createElement('template');
      t.innerHTML = '<p class="bad">in a template</p>';
      document.getElementById('app')!.append(t);
    });
    const delta = await step();
    expectNoWork(delta);
    expect(delta.irrelevantMutations).toBeGreaterThanOrEqual(2);
  });
});

test.describe('R1-E. theme switches on <html> and <body>', () => {
  async function themed() {
    const loaded = await open();
    await loaded.page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = [
        'html[data-theme="dark"] .pill, html[data-bs-theme="dark"] .pill,',
        'html[data-color-mode="dark"] .pill, html[data-mode="dark"] .pill,',
        'html[data-app-theme="dark"] .pill, html.dark .pill, body.dark .pill,',
        'body[data-theme="dark"] .pill, html[data-skin="dark"] .pill',
        '{ color: #c0392b; background-color: #27ae60; }',
      ].join('\n');
      document.head.append(style);
      document
        .getElementById('app')!
        .insertAdjacentHTML('beforeend', '<p id="pill" class="pill">Pill</p>');
    });
    await loaded.step();
    expect(await rule(loaded.page, 'pill')).toBe(false);
    return loaded;
  }

  const SWITCHES: Array<[string, string, string]> = [
    [
      'html data-theme',
      `document.documentElement.setAttribute('data-theme', 'dark')`,
      `document.documentElement.removeAttribute('data-theme')`,
    ],
    [
      'html data-bs-theme',
      `document.documentElement.setAttribute('data-bs-theme', 'dark')`,
      `document.documentElement.removeAttribute('data-bs-theme')`,
    ],
    [
      'html data-color-mode',
      `document.documentElement.setAttribute('data-color-mode', 'dark')`,
      `document.documentElement.removeAttribute('data-color-mode')`,
    ],
    [
      'html data-mode',
      `document.documentElement.setAttribute('data-mode', 'dark')`,
      `document.documentElement.removeAttribute('data-mode')`,
    ],
    [
      'html custom data-app-theme',
      `document.documentElement.setAttribute('data-app-theme', 'dark')`,
      `document.documentElement.removeAttribute('data-app-theme')`,
    ],
    [
      'html class',
      `document.documentElement.classList.add('dark')`,
      `document.documentElement.classList.remove('dark')`,
    ],
    ['body class', `document.body.classList.add('dark')`, `document.body.classList.remove('dark')`],
    [
      'body data-theme',
      `document.body.setAttribute('data-theme', 'dark')`,
      `document.body.removeAttribute('data-theme')`,
    ],
  ];

  for (const [name, on, off] of SWITCHES) {
    test(`${name}: exactly one full rescan per logical switch, and the page follows`, async () => {
      const { page, step } = await themed();
      await page.evaluate(on);
      const toDark = await step();
      expect(toDark.fullRescans).toBe(1);
      expect(toDark.fullRescansByReason['document-root']).toBe(1);
      expect(toDark.incrementalPasses).toBe(0);
      expect(await rule(page, 'pill')).toBe(true);
      expect((await computedColors(page, ['pill']))['pill']).not.toBe(ORIGINAL_BAD);

      await page.evaluate(off);
      const toLight = await step();
      expect(toLight.fullRescans).toBe(1);
      expect(toLight.fullRescansByReason['document-root']).toBe(1);
      expect(await rule(page, 'pill')).toBe(false);
      expect((await computedColors(page, ['pill']))['pill']).toBe('rgb(0, 0, 0)');
      await expectConsistent(page);
    });
  }

  test('one logical switch touching html and body, several attributes, is one rescan', async () => {
    const { page, step } = await themed();
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
      document.documentElement.setAttribute('data-bs-theme', 'dark');
      document.documentElement.classList.add('dark');
      document.body.classList.add('dark');
      document.body.setAttribute('data-theme', 'dark');
    });
    const delta = await step();
    expect(delta.fullRescans).toBe(1);
    expect(delta.fullRescansByReason['document-root']).toBe(1);
    expect(delta.mutationRecords).toBeGreaterThanOrEqual(5);
    expect(await rule(page, 'pill')).toBe(true);
  });

  test('dark -> light -> dark inside one batch is net zero: no rescan', async () => {
    const { page, step } = await themed();
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await step();
    await page.evaluate(() => {
      const root = document.documentElement;
      root.setAttribute('data-theme', 'dark');
      root.setAttribute('data-theme', 'light');
    });
    const delta = await step();
    expect(delta.fullRescans).toBe(0);
    expect(await rule(page, 'pill')).toBe(false);
  });

  test('unrelated <html>/<body> attributes (lang, scroll-lock) are ignored', async () => {
    const { page, step } = await themed();
    await page.evaluate(() => {
      document.documentElement.setAttribute('lang', 'fr');
      document.documentElement.setAttribute('data-scroll-locked', '1');
      document.body.setAttribute('data-modal-open', 'true');
      document.body.setAttribute('aria-hidden', 'false');
    });
    const delta = await step();
    expect(delta.fullRescans).toBe(0);
    expectNoWork(delta);
    expect(delta.irrelevantMutations).toBeGreaterThanOrEqual(4);
  });

  test('documented limit: an attribute name not recognised as a theme (data-skin) is not detected; refresh fixes it', async () => {
    const { page, step } = await themed();
    await page.evaluate(() => document.documentElement.setAttribute('data-skin', 'dark'));
    const delta = await step();
    expect(delta.fullRescans).toBe(0);
    expect(await rule(page, 'pill')).toBe(false);
    expect((await computedColors(page, ['pill']))['pill']).toBe(ORIGINAL_BAD); // still unadapted

    await refresh(ext.worker, page);
    await settle(page);
    expect(await rule(page, 'pill')).toBe(true);
    expect((await computedColors(page, ['pill']))['pill']).not.toBe(ORIGINAL_BAD);
  });
});
