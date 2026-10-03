import { afterEach, describe, expect, it } from 'vitest';
import {
  colorHintOf,
  defaultFactsEnvironment,
  effectiveRole,
  readElementFacts,
  readStyleSnapshot,
  visibleText,
} from '@features/semantics';
import { MAX_TEXT_LENGTH } from '@core/semantics';

const env = () => defaultFactsEnvironment(document);

function facts(markup: string, css = '', selector = '#x') {
  document.head.innerHTML = css ? `<style>${css}</style>` : '';
  document.body.innerHTML = markup;
  return readElementFacts(document.querySelector(selector)!, env());
}

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('M6 reading facts from the DOM', () => {
  it('kinds: text host, dot, control, other', () => {
    expect(facts('<span id="x" class="a">Hello</span>').kind).toBe('text');
    expect(
      facts(
        '<span id="x"></span>',
        '#x{display:inline-block;width:10px;height:10px;background-color:#27ae60}',
      ).kind,
    ).toBe('dot');
    // An empty box with no size of its own is not a dot.
    expect(facts('<span id="x"></span>').kind).toBe('other');
    expect(
      facts('<span id="x"></span>', '#x{display:inline-block;width:200px;height:200px}').kind,
    ).toBe('other');
    for (const tag of ['input', 'select', 'textarea', 'img', 'canvas']) {
      expect(facts(`<${tag} id="x">`).kind, tag).toBe('control');
    }
    expect(
      facts('<table><tbody><tr id="x"><td>x</td></tr></tbody></table>', 'tr{display:table-row}')
        .kind,
    ).toBe('other');
    expect(facts('<span id="x">y</span>', '#x{display:none}').kind).toBe('other');
    expect(facts('<span id="x">y</span>', '#x{display:contents}').kind).toBe('other');
  });

  it('prose-sized containers are not decorated', () => {
    expect(facts(`<div id="x">${'word '.repeat(80)}</div>`).kind).toBe('other');
  });

  it('roles: explicit first, then implicit by tag and input type', () => {
    document.body.innerHTML =
      '<div id="a" role="tab presentation"></div><button id="b"></button><a id="c" href="#"></a>' +
      '<input id="d" type="checkbox"><input id="e" type="submit"><input id="f">';
    const role = (id: string) => effectiveRole(document.getElementById(id)!);
    expect([role('a'), role('b'), role('c'), role('d'), role('e'), role('f')]).toEqual([
      'tab',
      'button',
      'link',
      'checkbox',
      'button',
      'textbox',
    ]);
  });

  it('tokens, ids, data-state, ARIA and title are read as written', () => {
    const f = facts(
      '<div id="x" class="Alert  error" data-state="Error" data-other="1" aria-invalid="true" aria-live="polite" aria-label="Oops" title="T">Hi</div>',
    );
    expect(f.classTokens).toEqual(['Alert', 'error']);
    expect(f.idTokens).toEqual(['x']);
    expect(f.dataValues).toEqual([{ name: 'data-state', value: 'Error' }]);
    expect(f.aria).toEqual({ 'aria-invalid': 'true', 'aria-live': 'polite' });
    expect(f.labelText).toBe('Oops');
    expect(f.title).toBe('T');
    expect(f.text).toBe('Hi');
  });

  it('aria-describedby text is resolved', () => {
    const f = facts(
      '<input id="x" aria-describedby="m1 m2"><p id="m1">Invalid</p><p id="m2">email</p>',
    );
    expect(f.describedByText).toBe('Invalid email');
  });

  it('visible text skips hidden and inert content and is bounded', () => {
    document.body.innerHTML =
      '<div id="x">A <span aria-hidden="true">hidden</span> <script>var s = 1</script>B</div>';
    expect(visibleText(document.getElementById('x')!)).toEqual({ text: 'A B', truncated: false });
    document.body.innerHTML = `<div id="x">${'x'.repeat(5000)}</div>`;
    const long = visibleText(document.getElementById('x')!);
    expect(long.truncated).toBe(true);
    expect(long.text.length).toBe(MAX_TEXT_LENGTH);
  });

  it('native: required, disabled, and the label that carries the requirement', () => {
    const f = facts('<label id="x" for="e">Email</label><input id="e" required>');
    expect(f.native.required).toBe(true);
    expect(facts('<input id="x" required>').native).toMatchObject({
      isControl: true,
      required: true,
      empty: true,
    });
    expect(facts('<input id="x" disabled>').native.disabled).toBe(true);
    expect(facts('<button id="x" disabled>b</button>').native.disabled).toBe(true);
    expect(facts('<label id="x" for="n">Name</label><input id="n">').native.required).toBe(false);
    // A submit button is not a field that can be required.
    expect(
      facts('<label id="x" for="s">Go</label><input id="s" type="submit" required>').native
        .required,
    ).toBe(false);
  });

  it('native: a pristine invalid field is not "invalid"; one that holds a bad value is (no :user-invalid here)', () => {
    expect(facts('<input id="x" type="email" required>').native).toMatchObject({
      invalid: true,
      nonPristine: false,
    });
    document.body.innerHTML = '<input id="x" type="email" required value="nope">';
    expect(readElementFacts(document.getElementById('x')!, env()).native).toMatchObject({
      invalid: true,
      nonPristine: true,
    });
  });

  it('pseudo-element content is read through the environment (jsdom cannot compute it)', () => {
    document.body.innerHTML = '<span id="x">x</span>';
    const element = document.getElementById('x')!;
    const base = env();
    const f = readElementFacts(element, {
      view: base.view,
      pseudoContent: (_el, pseudo) => (pseudo === '::after' ? '"✓"' : 'none'),
    });
    expect([f.beforeContent, f.afterContent]).toEqual([false, true]);
    // The default environment never reports content in jsdom, and never prints a "not implemented".
    expect(readElementFacts(element, base)).toMatchObject({
      beforeContent: false,
      afterContent: false,
    });
  });

  it('icons: inline SVG, <img>, role=img and icon-font classes, but not a plain span', () => {
    expect(facts('<span id="x"><svg width="8" height="8"></svg>t</span>').hasIcon).toBe(true);
    expect(facts('<span id="x"><img alt="warning" src="data:,">t</span>').hasIcon).toBe(true);
    expect(
      facts('<span id="x"><span role="img" aria-label="warning"></span>t</span>').hasIcon,
    ).toBe(true);
    expect(facts('<span id="x"><i class="fa fa-warning"></i>t</span>').hasIcon).toBe(true);
    expect(facts('<span id="x"><span class="material-icon">w</span>t</span>').hasIcon).toBe(true);
    expect(facts('<span id="x"><b>t</b></span>').hasIcon).toBe(false);
  });

  it('control variants are recognised as interactive', () => {
    expect(facts('<button id="x" class="btn btn-danger">Delete</button>').isInteractive).toBe(true);
    expect(facts('<a id="x" href="#">x</a>').isInteractive).toBe(true);
    expect(facts('<span id="x">x</span>').isInteractive).toBe(false);
  });
});

describe('M6 color hints (weak, supporting context only)', () => {
  it('names clear hues and nothing ambiguous', () => {
    expect(colorHintOf('#c0392b')).toBe('red');
    expect(colorHintOf('rgb(255, 0, 0)')).toBe('red');
    expect(colorHintOf('#27ae60')).toBe('green');
    expect(colorHintOf('#f1c40f')).toBe('yellow');
    expect(colorHintOf('#2980b9')).toBe('blue');
    expect(colorHintOf('#888888')).toBeNull(); // gray
    expect(colorHintOf('#000000')).toBeNull();
    expect(colorHintOf('#ffffff')).toBeNull();
    expect(colorHintOf('#8e44ad')).toBeNull(); // purple: not part of the vocabulary
    expect(colorHintOf('rgba(255, 0, 0, 0.1)')).toBeNull(); // nearly transparent
    expect(colorHintOf('transparent')).toBeNull();
    expect(colorHintOf('nonsense')).toBeNull();
  });
});

describe('M6 style snapshots', () => {
  it('split non-paint properties from paint, and leave out the focus ring of a focused element', () => {
    document.head.innerHTML =
      '<style>#a{color:#c0392b;font-weight:700;background-color:#27ae60}#b{color:#2980b9}</style>';
    document.body.innerHTML = '<input id="a"><input id="b">';
    const view = document.defaultView!;
    const a = readStyleSnapshot(document.getElementById('a')!, view, 'control');
    const b = readStyleSnapshot(document.getElementById('b')!, view, 'control');
    expect(a.paint.color).toBe('rgb(192, 57, 43)');
    expect(a.paint['background-color']).toBe('rgb(39, 174, 96)');
    expect(a.shape['font-weight']).toBe('700');
    expect(b.shape['font-weight']).not.toBe('700');
    expect('outline-style' in a.shape).toBe(true);

    document.getElementById('a')!.focus();
    const focused = readStyleSnapshot(document.getElementById('a')!, view, 'control');
    expect('outline-style' in focused.shape).toBe(false);
    expect('outline-width' in focused.shape).toBe(false);
  });

  it('text hosts leave out width and height (the text decides them)', () => {
    document.body.innerHTML = '<span id="a">x</span>';
    const view = document.defaultView!;
    const text = readStyleSnapshot(document.getElementById('a')!, view, 'text');
    const dot = readStyleSnapshot(document.getElementById('a')!, view, 'dot');
    expect('width' in text.shape).toBe(false);
    expect('width' in dot.shape).toBe(true);
  });
});
