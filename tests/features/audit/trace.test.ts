import { afterEach, describe, expect, it } from 'vitest';
import { analyzeDocument } from '@core/analysis';
import { traceTextElement } from '../../../src/features/audit/trace';

/** M10.R1: discovery of text in text-flow elements, and the debug trace that explains every decision. */
afterEach(() => {
  document.body.innerHTML = '';
});

const el = (id: string) => document.getElementById(id)!;
const LOW = 'color:#999999;background:#ffffff;';

describe('text-flow discovery (the 290 misses of the M10 real-world comparison)', () => {
  it.each([
    'div',
    'time',
    'abbr',
    'code',
    'b',
    'var',
    'kbd',
    'blockquote',
    'dd',
    'i',
    'pre',
    'section',
  ])('finds text directly inside <%s>', (tag) => {
    document.body.innerHTML = `<${tag} id="t" style="${LOW}">Some text</${tag}>`;
    const { elements } = analyzeDocument({ now: () => 0 });
    expect(elements.map((e) => e.tagName)).toEqual([tag]);
    expect(elements[0]!.hasTextContent).toBe(true);
  });

  it('a bare wrapper is not a descriptor, and an element with text of its own beside a child is', () => {
    document.body.innerHTML = `<div id="w"><p id="p" style="${LOW}">inner</p></div><div id="mixed" style="${LOW}">own <span id="s" style="${LOW}">child</span></div>`;
    const { elements, truncated } = analyzeDocument({ now: () => 0 });
    expect(truncated).toBe(false);
    expect(elements.map((e) => e.tagName)).toEqual(['p', 'div', 'span']);
  });

  it('bare wrappers do not consume the element budget', () => {
    document.body.innerHTML = `${'<div><div><div></div></div></div>'.repeat(30)}<p style="${LOW}">x</p>`;
    const { elements, truncated } = analyzeDocument({ now: () => 0, maxElements: 1 });
    expect(elements).toHaveLength(1);
    expect(truncated).toBe(false);
  });

  it('finds text inside any element, known or not: custom elements, typos, new HTML', () => {
    document.body.innerHTML = `<my-label style="${LOW}">custom</my-label><d style="${LOW}">typo tag</d><fancy-x style="${LOW}">x</fancy-x>`;
    const { elements } = analyzeDocument({ now: () => 0 });
    expect(elements.map((e) => e.tagName)).toEqual(['my-label', 'd', 'fancy-x']);
  });

  it('never reads metadata, scripts, templates or options as page text', () => {
    document.body.innerHTML = `<script style="${LOW}">var a = 1;</script><style>p{}</style><template style="${LOW}">t</template><select><option style="${LOW}">o</option></select><p style="${LOW}">real</p>`;
    expect(analyzeDocument({ now: () => 0 }).elements.map((e) => e.tagName)).toEqual([
      'select',
      'p',
    ]);
  });

  it('keeps every element the first selector had', () => {
    document.body.innerHTML = `<a href="#" style="${LOW}">a</a><button style="${LOW}">b</button><p style="${LOW}">p</p><span style="${LOW}">s</span><ul><li style="${LOW}">l</li></ul><h1 style="${LOW}">h</h1><table><tbody><tr><td style="${LOW}">t</td></tr></tbody></table><strong style="${LOW}">x</strong><label style="${LOW}">l</label><small style="${LOW}">m</small>`;
    expect(
      analyzeDocument({ now: () => 0 })
        .elements.map((e) => e.tagName)
        .sort(),
    ).toEqual(['a', 'button', 'p', 'span', 'li', 'h1', 'td', 'strong', 'label', 'small'].sort());
  });
});

describe('traceTextElement', () => {
  const trace = (html: string) => {
    document.body.innerHTML = html;
    return traceTextElement(el('t'));
  };

  it('REPORTED: low contrast', () => {
    const t = trace(`<div id="t" style="${LOW}">x</div>`);
    expect(t).toMatchObject({
      stage: 'FAILED_THRESHOLD',
      reason: 'REPORTED',
      reported: true,
      target: 4.5,
    });
    expect(t.ratio).toBeCloseTo(2.85, 2);
  });

  it('PASS_CONTRAST', () => {
    const t = trace('<div id="t" style="color:#000;background:#fff">x</div>');
    expect(t).toMatchObject({ stage: 'EVALUATED', reason: 'PASS_CONTRAST', reported: false });
  });

  it('large text uses the 3:1 target', () => {
    const t = trace('<div id="t" style="color:#767676;background:#fff;font-size:24px">x</div>');
    expect(t).toMatchObject({ largeText: true, target: 3, reason: 'PASS_CONTRAST' });
  });

  it('SKIP_HIDDEN, NO_OWN_TEXT, SKIP_DISABLED, NOT_A_CANDIDATE, UNRESOLVED_BACKGROUND', () => {
    expect(trace(`<div id="t" style="${LOW}display:none">x</div>`).reason).toBe('SKIP_HIDDEN');
    expect(trace(`<div id="t" style="${LOW}">  <p>x</p></div>`).reason).toBe('NO_OWN_TEXT');
    expect(trace(`<button id="t" disabled style="${LOW}">x</button>`).reason).toBe('SKIP_DISABLED');
    expect(trace(`<noscript id="t">x</noscript>`).reason).toBe('NOT_A_CANDIDATE');
    expect(
      trace('<div id="t" style="color:#999;background-image:linear-gradient(#fff,#eee)">x</div>')
        .reason,
    ).toBe('UNRESOLVED_BACKGROUND');
  });

  it('agrees with analyzeDocument: a traced-skipped element has no descriptor', () => {
    document.body.innerHTML = `<div id="t" style="${LOW}visibility:hidden">x</div>`;
    expect(analyzeDocument({ now: () => 0 }).elements).toHaveLength(0);
    expect(traceTextElement(el('t')).reason).toBe('SKIP_HIDDEN');
  });
});
