import { expect, test } from '@playwright/test';
import {
  launchExtension,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';
import { load } from './r1-kit';
import { SETTINGS } from './semantic-kit';
import {
  ADVERSARIAL_CSS,
  ADVERSARIAL_SCENARIOS,
} from '../tests/features/semantics/adversarial-scenarios';

/**
 * The adversarial semantic benchmark in real Chromium: the very scenarios of
 * tests/features/semantics/adversarial.test.ts, each on its own page with the extension running.
 * Hard gate: not one automatic cue on an element that must not get one.
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

/** `after:2713` -> `after ✓`, `inner:2713:d:10` -> `inner ✓`; outline and underline keys as they are. */
function describeKey(key: string | null): string | null {
  if (!key) return null;
  const [placement, hex] = key.split(':');
  if (placement === 'after' || placement === 'before' || placement === 'inner') {
    return `${placement} ${String.fromCodePoint(Number.parseInt(hex!, 16))}`;
  }
  return key;
}

const pageFor = (html: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>adversarial</title><style>${ADVERSARIAL_CSS}</style></head><body>${html}</body></html>`;

test.describe.configure({ mode: 'serial' });

test('144+ adversarial scenarios in Chromium: zero wrong automatic cues, no missed curated cue', async () => {
  test.setTimeout(600_000);
  expect(ADVERSARIAL_SCENARIOS.length).toBeGreaterThanOrEqual(100);

  const wrong: string[] = [];
  const missed: string[] = [];
  let autoCues = 0;
  let elements = 0;

  for (const [index, scenario] of ADVERSARIAL_SCENARIOS.entries()) {
    const name = `adv-${index}.html`;
    server.serve(name, pageFor(scenario.html));
    const { page } = await load(ext, server, name, SETTINGS);
    const actual = await page.evaluate(
      (selectors) => ({
        listed: Object.fromEntries(
          selectors.map((selector) => [
            selector,
            document.querySelector(selector)?.getAttribute('data-coloradapt-cue') ?? null,
          ]),
        ),
        total: document.querySelectorAll('[data-coloradapt-cue]').length,
      }),
      Object.keys(scenario.expect),
    );

    const expectsNoCue = Object.values(scenario.expect).every((e) => e.cue === null);
    for (const [selector, expected] of Object.entries(scenario.expect)) {
      elements += 1;
      const got = describeKey(actual.listed[selector] ?? null);
      if (got !== null) autoCues += 1;
      if (got !== expected.cue) {
        const line = `[${index}] ${scenario.name} ${selector}: expected ${expected.cue}, got ${got}`;
        if (got !== null) wrong.push(line);
        else if (scenario.curatedPositive) missed.push(line);
        else wrong.push(line);
      }
    }
    // A scenario that expects no cue at all must leave the whole page without one.
    if (expectsNoCue && actual.total !== 0) {
      wrong.push(`[${index}] ${scenario.name}: ${actual.total} cue(s) on a page that expects none`);
    }
    await page.close();
  }

  process.stdout.write(
    `semantic adversarial (Chromium): scenarios=${ADVERSARIAL_SCENARIOS.length} elements=${elements} autoCues=${autoCues} wrong=${wrong.length} missed=${missed.length}
`,
  );
  expect({ wrong, missed }, 'wrong / missed cues').toEqual({ wrong: [], missed: [] });
});
