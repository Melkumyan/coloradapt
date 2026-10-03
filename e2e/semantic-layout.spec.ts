import { expect, test, type Page } from '@playwright/test';
import {
  launchExtension,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';
import { load } from './r1-kit';
import { SETTINGS, cues, openOff, pixels, pseudo, turnOn } from './semantic-kit';

/**
 * M6.R1 in a real browser, part 2: do the cues survive real layouts, fonts, zoom, themes and
 * forced colors, and is a cue that cannot be shown withheld instead of faked?
 *
 * Browser zoom (Ctrl +) cannot be driven reliably in headless Chromium, so zoom is CSS `zoom` on
 * the document and font-size scaling: the cue is sized in `em`, so both exercise the same thing.
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

const LAYOUT = 'semantic-layout.html';

/** Pairs of (success badge, error badge) in each layout the milestone names. */
const TEXT_LAYOUTS = [
  'inline',
  'block',
  'flex',
  'iflex',
  'grid',
  'abs',
  'clip-room',
  'small',
  'large',
  'dark',
  'mono',
  'nofont',
  'serif',
  'cursive',
  'symbolfont',
] as const;
/**
 * Placements that cannot take a glyph without changing layout or being cut off, so none is added
 * (docs/SEMANTIC_ACCESSIBILITY.md, "Verified placement"): a grid host puts the glyph in a new
 * row (decided before anything is applied), and a clipped, ellipsized label would hide it
 * (planned, then taken back when the browser shows it does not fit).
 */
const UNSUPPORTED = ['igrid-a', 'igrid-b', 'clip-tight-a', 'clip-tight-b'] as const;
/** Planned, then taken back: the glyph would have been cut off, or wrapped onto a second line of its host. */
const DOES_NOT_FIT = ['clip-tight-a', 'clip-tight-b', 'narrow-a', 'narrow-b'] as const;
const FONT_CASES = ['mono', 'nofont', 'serif', 'cursive', 'symbolfont'] as const;

function expectedCues(): Record<string, RegExp> {
  const expected: Record<string, RegExp> = {};
  for (const name of TEXT_LAYOUTS) {
    expected[`${name}-a`] = /^after:2713$/;
    expected[`${name}-b`] = /^after:d7$/;
  }
  expected['dflex-a'] = /^inner:2713:/;
  expected['dflex-b'] = /^inner:d7:/;
  expected['dgrid-a'] = /^inner:2713:/;
  expected['dgrid-b'] = /^inner:d7:/;
  expected['tabs-a'] = /^underline$/;
  return expected;
}

interface Problem {
  readonly id: string;
  readonly cue: string;
  readonly problem: string;
}

/**
 * For every element carrying a cue right now: the pseudo-element exists and is laid out, a dot
 * did not change size, text did not become taller, and nothing is clipped. The cue is taken off
 * and put back (an unobserved attribute) to measure the host without it.
 */
function cueProblems(page: Page): Promise<Problem[]> {
  return page.evaluate(() => {
    const found: Problem[] = [];
    for (const el of document.querySelectorAll('[data-coloradapt-cue]')) {
      const cue = el.getAttribute('data-coloradapt-cue') ?? '';
      const placement = cue.split(':')[0]!;
      const withCue = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      let problem = '';
      if (placement === 'after' || placement === 'before' || placement === 'inner') {
        const pseudoStyle = getComputedStyle(el, placement === 'before' ? '::before' : '::after');
        if (pseudoStyle.content === 'none' || pseudoStyle.content === 'normal')
          problem = 'no content';
        else if (pseudoStyle.display === 'none') problem = 'display none';
        else if (placement === 'inner' && !(Number.parseFloat(pseudoStyle.width) > 0))
          problem = 'inner cue has no size';
        const clips = style.overflowX !== 'visible' || style.overflowY !== 'visible';
        if (
          !problem &&
          clips &&
          (el.scrollWidth > el.clientWidth + 0.5 || el.scrollHeight > el.clientHeight + 0.5)
        ) {
          problem = 'clipped by the host';
        }
      }
      el.removeAttribute('data-coloradapt-cue');
      const without = el.getBoundingClientRect();
      el.setAttribute('data-coloradapt-cue', cue);
      if (!problem && Math.abs(withCue.height - without.height) >= 0.5) problem = 'host got taller';
      if (!problem && placement === 'inner' && Math.abs(withCue.width - without.width) >= 0.5) {
        problem = 'dot changed width';
      }
      found.push({ id: el.id, cue, problem });
    }
    return found.filter((entry) => entry.problem !== '');
  });
}

test.describe('M6.R1 layouts', () => {
  test('inline, inline-block, flex, grid, positioned, overflow-hidden, small, large, dark: cued and sound', async () => {
    const { page, diag } = await load(ext, server, LAYOUT, SETTINGS);
    const actual = await cues(page);
    for (const [id, pattern] of Object.entries(expectedCues())) {
      expect(actual[id], `#${id}`).toMatch(pattern);
    }
    expect(await cueProblems(page)).toEqual([]);
    const { semantic } = await diag();
    expect(semantic.cuesApplied - semantic.cuesRemoved).toBe(semantic.cuesActive);
  });

  test('a cue that cannot be shown is withheld, not faked: a clipped label, a column too narrow and an inline-grid host get none, and none is claimed', async () => {
    const { page, diag } = await load(ext, server, LAYOUT, SETTINGS);
    const actual = await cues(page);
    for (const id of [...UNSUPPORTED, ...DOES_NOT_FIT]) {
      expect(actual[id], `#${id}`).toBeUndefined();
    }
    const { semantic } = await diag();
    // The clipped pair and the pair in a column too narrow were planned and taken back; the grid
    // host was never planned (no safe placement).
    expect(semantic.cuesNotApplied).toBe(DOES_NOT_FIT.length);
    expect(semantic.cuesPlanned).toBe(semantic.cuesApplied + semantic.cuesNotApplied);
    // Whatever stayed on a narrow column is sound too.
    expect(await cueProblems(page)).toEqual([]);
  });

  test('every cue that is applied really changes what is drawn (pixels differ from the same page without it)', async () => {
    const plain = await openOff(ext, server, LAYOUT);
    const ids = Object.keys(expectedCues()).filter((id) => !id.startsWith('abs'));
    const before = Object.fromEntries(
      await Promise.all(ids.map(async (id) => [id, await pixels(plain, id)] as const)),
    );
    await plain.close();
    const page = await openOff(ext, server, LAYOUT);
    await turnOn(ext, page);
    for (const id of ids) expect(await pixels(page, id), `#${id}`).not.toBe(before[id]);
  });
});

test.describe('M6.R1 zoom and text size', () => {
  test('at 100%, 125%, 150% and 200% the cues are still there, still visible and still not changing layout', async () => {
    const { page, step } = await load(ext, server, LAYOUT, SETTINGS);
    const baseWidth = await page.evaluate(
      () => document.getElementById('block-a')!.getBoundingClientRect().width,
    );
    for (const zoom of [1, 1.25, 1.5, 2]) {
      await page.evaluate((z) => {
        document.documentElement.style.zoom = String(z);
      }, zoom);
      await step();
      const actual = await cues(page);
      for (const [id, pattern] of Object.entries(expectedCues())) {
        expect(actual[id], `#${id} at ${zoom}`).toMatch(pattern);
      }
      expect(await cueProblems(page), `zoom ${zoom}`).toEqual([]);
      const width = await page.evaluate(
        () => document.getElementById('block-a')!.getBoundingClientRect().width,
      );
      // The page really scaled, and the glyph scaled with it (it is sized in em).
      expect(width / baseWidth).toBeGreaterThan(zoom * 0.9);
      expect(width / baseWidth).toBeLessThan(zoom * 1.1);
    }
  });

  test('small (9px) and large (28px) text: the glyph is in proportion to its text', async () => {
    const { page } = await load(ext, server, LAYOUT, SETTINGS);
    const size = (id: string) =>
      page.evaluate((target) => {
        const el = document.getElementById(target)!;
        const style = getComputedStyle(el, '::after');
        return {
          glyph: Number.parseFloat(style.width),
          text: Number.parseFloat(getComputedStyle(el).fontSize),
        };
      }, id);
    const small = await size('small-a');
    const large = await size('large-a');
    expect(small.text).toBe(9);
    expect(large.text).toBe(28);
    expect(small.glyph / small.text).toBeCloseTo(0.8, 1); // .8em, whatever the text size
    expect(large.glyph / large.text).toBeCloseTo(0.8, 1);
  });
});

test.describe('M6.R1 fonts', () => {
  test('text glyphs are drawn in the cue font stack, whatever the page font (monospace, missing, serif, cursive, symbol)', async () => {
    const { page } = await load(ext, server, LAYOUT, SETTINGS);
    for (const name of FONT_CASES) {
      const host = await page.evaluate(
        (id) => getComputedStyle(document.getElementById(id)!).fontFamily,
        `${name}-b`,
      );
      const cue = await pseudo(page, `${name}-b`);
      expect(cue.content, name).toContain('×');
      // The cue never inherits the page font (an icon font would have turned × into a blank).
      expect(cue.fontFamily, name).toContain('system-ui');
      expect(cue.fontFamily, name).not.toBe(host);
      // The success mark is a shape: no font involved at all.
      const check = await pseudo(page, `${name}-a`);
      expect(check.content, name).toBe('"" / ""');
      expect(check.clipPath, name).toContain('polygon(');
    }
    expect(await cueProblems(page)).toEqual([]);
  });

  test('every glyph the cues draw as text renders as a real glyph in the cue font stack on this system', async () => {
    const { page } = await load(ext, server, LAYOUT, SETTINGS);
    const report = await page.evaluate(() => {
      const stack = getComputedStyle(document.getElementById('mono-b')!, '::after').fontFamily;
      const draw = (glyph: string) => {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.font = `700 40px ${stack}`;
        ctx.fillText(glyph, 6, 48);
        const alpha: number[] = [];
        const data = ctx.getImageData(0, 0, 64, 64).data;
        for (let i = 3; i < data.length; i += 4) alpha.push(data[i]!);
        return { ink: alpha.filter((a) => a > 0).length, hash: alpha.join(',') };
      };
      const tofu = draw('\u{10FFFF}');
      const result: Record<string, { drawn: boolean; tofu: boolean }> = {};
      for (const glyph of ['×', '!', '*', '+', '−', '↑', '↓', 'i', '✓', 'ℹ']) {
        const shape = draw(glyph);
        result[glyph] = { drawn: shape.ink > 0, tofu: shape.hash === tofu.hash };
      }
      return { stack, result };
    });
    // The glyphs the cues rely on: present everywhere (Latin-1 / WGL4).
    for (const glyph of ['×', '!', '*', '+', '−', '↑', '↓', 'i']) {
      expect(report.result[glyph], glyph).toEqual({ drawn: true, tofu: false });
    }
    // The two rare ones are not relied upon (drawn as shapes); what this system has is only informational.
    process.stdout.write(
      `rare glyphs on this system: ${JSON.stringify({ '✓': report.result['✓'], ℹ: report.result['ℹ'] })}
`,
    );
  });
});

test.describe('M6.R1 themes', () => {
  test('dark mode: glyphs follow the text color and read against their background; underlines follow the text', async () => {
    const { page } = await load(ext, server, LAYOUT, SETTINGS);
    await page.emulateMedia({ colorScheme: 'dark' });
    const report = await page.evaluate(() => {
      const parse = (css: string) =>
        (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number) as [number, number, number];
      const lum = ([r, g, b]: [number, number, number]) => {
        const f = (c: number) => (c / 255) ** 2.2;
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const contrast = (a: string, b: string) => {
        const [x, y] = [lum(parse(a)), lum(parse(b))].sort((p, q) => q - p);
        return (x! + 0.05) / (y! + 0.05);
      };
      const out: Record<string, number | string> = {};
      for (const id of ['dark-a', 'dark-b', 'block-a', 'block-b']) {
        const el = document.getElementById(id)!;
        const host = getComputedStyle(el);
        const glyph = getComputedStyle(el, '::after');
        out[`${id}.sameColor`] = glyph.color === host.color ? 1 : 0;
        out[`${id}.contrast`] = contrast(host.color, host.backgroundColor);
      }
      const tab = document.getElementById('tabs-a')!;
      const tabStyle = getComputedStyle(tab);
      out['tab.line'] = tabStyle.textDecorationLine;
      out['tab.contrast'] = contrast(
        tabStyle.textDecorationColor,
        getComputedStyle(document.body).backgroundColor,
      );
      return out;
    });
    for (const id of ['dark-a', 'dark-b', 'block-a', 'block-b']) {
      expect(report[`${id}.sameColor`], id).toBe(1);
      expect(report[`${id}.contrast`] as number, id).toBeGreaterThan(3);
    }
    expect(report['tab.line']).toContain('underline');
    expect(report['tab.contrast'] as number).toBeGreaterThan(3);
    expect(await cueProblems(page)).toEqual([]);
  });

  test('forced-colors: the drawn check keeps a color that is not the background, text glyphs take the forced text color', async () => {
    const { page } = await load(ext, server, LAYOUT, SETTINGS);
    await page.emulateMedia({ forcedColors: 'active' });
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
    const read = (id: string) =>
      page.evaluate((target) => {
        const el = document.getElementById(target)!;
        const host = getComputedStyle(el);
        const glyph = getComputedStyle(el, '::after');
        return {
          hostColor: host.color,
          hostBackground: host.backgroundColor,
          glyphColor: glyph.color,
          glyphBackground: glyph.backgroundColor,
          clipPath: glyph.clipPath,
          line: host.textDecorationLine,
        };
      }, id);

    const check = await read('block-a'); // a drawn shape
    expect(check.clipPath).toContain('polygon(');
    expect(check.glyphBackground).not.toBe('rgba(0, 0, 0, 0)');
    expect(check.glyphBackground).not.toBe(check.hostBackground);
    const dot = await read('dflex-a'); // a drawn shape inside a dot
    expect(dot.glyphBackground).not.toBe('rgba(0, 0, 0, 0)');
    expect(dot.glyphBackground).not.toBe(dot.hostBackground);
    const text = await read('block-b'); // a text glyph
    expect(text.glyphColor).toBe(text.hostColor);
    expect((await read('tabs-a')).line).toContain('underline');
    expect(await cueProblems(page)).toEqual([]);
  });
});
