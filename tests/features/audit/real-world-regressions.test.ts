import { afterEach, describe, expect, it } from 'vitest';
import { analyzeDocument } from '@core/analysis';
import { isRendered } from '../../../src/features/audit/rendered';
import { traceTextElement } from '../../../src/features/audit/trace';

/**
 * M10.R1: deterministic regressions minimized from the real-world corpus (one family each), plus the
 * policies the closeout documents (docs/REAL_WORLD_FINDINGS_CLOSEOUT.md).
 */
afterEach(() => {
  document.body.innerHTML = '';
});

const el = (id: string) => document.getElementById(id)!;
const trace = (html: string) => {
  document.body.innerHTML = html;
  return traceTextElement(el('t'));
};

describe('visibility: the audit judges only text that is painted (about half of the M10 findings were not)', () => {
  it('an element inside a display:none ancestor is not rendered, although its own style says block', () => {
    document.body.innerHTML = `<div style="display:none"><p id="t" style="color:#999;background:#fff">hidden menu</p></div>`;
    expect(getComputedStyle(el('t')).display).not.toBe('none');
    expect(isRendered(el('t'))).toBe(false);
    expect(traceTextElement(el('t')).reason).toBe('SKIP_NOT_RENDERED');
  });

  it.each([
    ['display:none on itself', '<p id="t" style="display:none">x</p>'],
    ['visibility:hidden', '<p id="t" style="visibility:hidden">x</p>'],
    ['opacity:0', '<p id="t" style="opacity:0">x</p>'],
    ['opacity:0 on an ancestor', '<div style="opacity:0"><p id="t">x</p></div>'],
    [
      'font-size:0 (glyphs of no size paint nothing)',
      '<button id="t" style="font-size:0">Menu</button>',
    ],
    [
      'a nested display:none ancestor',
      '<div><div style="display:none"><span><p id="t">x</p></span></div></div>',
    ],
  ])('%s is not rendered', (_, html) => {
    document.body.innerHTML = html;
    expect(isRendered(el('t'))).toBe(false);
  });

  it.each([
    ['plain text', '<p id="t">x</p>'],
    ['partly transparent', '<p id="t" style="opacity:0.4">x</p>'],
    ['far off screen, but with a box', '<p id="t" style="position:absolute;left:-9999px">x</p>'],
    ['below the fold', '<div style="height:5000px"></div><p id="t">x</p>'],
  ])('%s is rendered', (_, html) => {
    document.body.innerHTML = html;
    expect(isRendered(el('t'))).toBe(true);
  });

  it('fallback content of <video>, <audio> and <canvas> is never painted', () => {
    document.body.innerHTML = '<video id="t">Your browser does not support video.</video>';
    expect(isRendered(el('t'))).toBe(false);
    document.body.innerHTML = '<canvas><p id="t">fallback</p></canvas>';
    expect(isRendered(el('t'))).toBe(false);
  });

  it('display:contents takes its box from the parent: its text is painted', () => {
    document.body.innerHTML = `<div><span id="t" style="display:contents;color:#999;background:#fff">own text</span></div>`;
    expect(isRendered(el('t'))).toBe(true);
    document.body.innerHTML = `<div style="display:none"><span id="t" style="display:contents">own text</span></div>`;
    expect(isRendered(el('t'))).toBe(false);
  });

  it('the visually-hidden pattern (clip: rect(0 0 0 0), clip-path: inset(50%)) paints nothing, whatever the box size', () => {
    // no text of its own: jsdom has no text boxes to ask, the clip rules are what is under test
    document.body.innerHTML = '<label id="t"><i></i></label>';
    const node = el('t') as Element & { checkVisibility?: unknown };
    node.checkVisibility = () => true;
    const real = (e: Element) => getComputedStyle(e);
    const withStyle = (extra: Record<string, string>) => (e: Element) =>
      new Proxy(real(e), {
        get: (target, prop) =>
          prop in extra ? extra[prop as string] : (Reflect.get(target, prop) as unknown),
      });
    expect(isRendered(node, withStyle({ clip: 'rect(0px, 0px, 0px, 0px)' }))).toBe(false);
    expect(isRendered(node, withStyle({ clipPath: 'inset(50%)' }))).toBe(false);
    expect(isRendered(node, withStyle({ clip: 'auto' }))).toBe(true);
  });

  it('uses the browser answer when there is one (checkVisibility)', () => {
    document.body.innerHTML = '<p id="t">x</p>';
    const node = el('t') as Element & { checkVisibility?: unknown };
    node.checkVisibility = () => false;
    expect(isRendered(node)).toBe(false);
    node.checkVisibility = () => true;
    expect(isRendered(node)).toBe(true);
  });
});

describe('background: unresolved stays unresolved, never a made-up ratio', () => {
  it('text on nested transparent ancestors takes the first opaque one', () => {
    const t = trace(
      '<div style="background:#202020"><div><section><p id="t" style="color:#ffffff">x</p></section></div></div>',
    );
    expect(t).toMatchObject({ background: '#202020', reason: 'PASS_CONTRAST' });
  });

  it('a translucent background composes over what is below it', () => {
    const t = trace(
      '<div style="background:#ffffff"><p id="t" style="color:#000000;background:rgba(0,0,0,0.5)">x</p></div>',
    );
    expect(t.background).toBe('#808080');
    expect(t.ratio).toBeCloseTo(5.32, 1);
  });

  it('opacity on an ancestor is one group: the text and its background fade together', () => {
    const t = trace(
      '<div style="opacity:0.5;background:#000000"><p id="t" style="color:#ffffff">x</p></div>',
    );
    // the group (white text on black) at 50% over the white canvas: the text stays white, the black becomes
    // #7f7f7f (127.5): L = 0.2140, ratio = 1.05 / 0.2640 = 3.977. A flat model (text x 0.5, background as is)
    // would say something else; the browser paints the group.
    expect(t.ratio!).toBeCloseTo(3.977, 2);
  });

  it.each([
    ['a gradient', 'background-image:linear-gradient(#fff,#eee)'],
    ['an image', 'background-image:url(data:image/gif;base64,R0lGODlhAQABAAAAACw=)'],
  ])('%s: UNRESOLVED_BACKGROUND, no ratio', (_, css) => {
    const t = trace(`<div id="t" style="color:#999;${css}">x</div>`);
    expect(t).toMatchObject({ reason: 'UNRESOLVED_BACKGROUND', ratio: null });
  });

  it('background-clip: text paints the glyphs, so the background color is not what the text sits on', () => {
    const t = trace(
      '<a id="t" href="#" style="color:#746e7c;background-color:#746e7c;-webkit-background-clip:text;background-clip:text">link</a>',
    );
    expect(t.reason).toBe('UNRESOLVED_BACKGROUND');
    expect(t.ratio).toBeNull();
  });

  it.each([
    ['a blend mode', 'mix-blend-mode:multiply'],
    ['a backdrop filter', 'backdrop-filter:blur(4px)'],
    ['a color-changing filter', 'filter:grayscale(1)'],
  ])('%s above the text: a best-effort limit, not a confirmed issue', (_, css) => {
    const t = trace(`<div style="${css};background:#fff"><p id="t" style="color:#999">x</p></div>`);
    expect(t.reason).toBe('PARTIAL_BACKGROUND');
  });

  it('a filter that keeps colors (a drop shadow, a blur) is not a limit', () => {
    const t = trace(
      '<div style="filter:drop-shadow(0 0 2px #000);background:#fff"><p id="t" style="color:#999">x</p></div>',
    );
    expect(t.reason).toBe('REPORTED');
  });
});

describe('foreground: what the glyphs are painted with', () => {
  it('-webkit-text-fill-color overrides color (the browser paints the fill)', () => {
    const t = trace(
      '<p id="t" style="color:#000000;-webkit-text-fill-color:#767676;background:#ffffff">x</p>',
    );
    expect(t.foreground).toBe('#767676');
    expect(t.ratio!).toBeCloseTo(4.542, 2);
  });

  it('without a fill, color is used', () => {
    const t = trace('<p id="t" style="color:#767676;background:#ffffff">x</p>');
    expect(t.foreground).toBe('#767676');
  });

  it('an rgba color is composited over the background, ancestor opacity applies once', () => {
    const t = trace(
      '<div style="opacity:0.5;background:#ffffff"><p id="t" style="color:rgba(0,0,0,0.5)">x</p></div>',
    );
    expect(t.foreground).toBe('#bfbfbf'); // 127.5 at group opacity .5 over the white canvas = 191.25
  });
});

describe('text ownership: a parent keeps its own text, a wrapper never duplicates its child', () => {
  it('the parent text and the child text are two findings, a bare wrapper is none', () => {
    document.body.innerHTML = `<div id="wrap" style="color:#999;background:#fff"><p id="p" style="color:#999;background:#fff">child text</p></div>
      <div id="mixed" style="color:#999;background:#fff">parent text <span id="s" style="color:#999;background:#fff">child</span></div>`;
    const ids = analyzeDocument({ now: () => 0 }).elements.map((e) => e.tagName);
    expect(ids).toEqual(['p', 'div', 'span']);
  });

  it('zero-width characters are not text (U+200B in a button next to an icon)', () => {
    document.body.innerHTML = '<span id="t" style="color:#999;background:#fff">\u200b</span>';
    expect(traceTextElement(el('t')).reason).toBe('NO_OWN_TEXT');
    document.body.innerHTML = '<span id="t" style="color:#999;background:#fff">\u200bA</span>';
    expect(traceTextElement(el('t')).reason).toBe('REPORTED');
  });

  it('whitespace-only text nodes do not make an owner', () => {
    document.body.innerHTML = '<div id="t" style="color:#999">  \n <p>x</p> \n</div>';
    expect(traceTextElement(el('t')).reason).toBe('NO_OWN_TEXT');
  });

  it('text inside an inline SVG belongs to the SVG unit, not to this rule', () => {
    document.body.innerHTML = '<svg><text id="t" fill="#999">svg text</text></svg>';
    expect(traceTextElement(document.getElementById('t') as unknown as Element).reason).toBe(
      'INSIDE_SVG_UNIT',
    );
  });
});

describe('scope: documented limits', () => {
  it('disabled controls are out of scope (their colors are the browser default, not the author)', () => {
    expect(
      trace('<button id="t" disabled style="color:#999;background:#fff">x</button>').reason,
    ).toBe('SKIP_DISABLED');
    expect(
      trace('<div id="t" aria-disabled="true" style="color:#999;background:#fff">x</div>').reason,
    ).toBe('SKIP_DISABLED');
  });

  it('generated content (::before / ::after) is not analyzed: there is no node to read', () => {
    document.body.innerHTML =
      '<style>#t::before{content:"generated";color:#ccc}</style><div id="t" style="color:#000;background:#fff"></div>';
    expect(traceTextElement(el('t')).reason).toBe('NO_OWN_TEXT');
  });
});
