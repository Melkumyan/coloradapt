import { afterEach, describe, expect, it } from 'vitest';
import {
  OBSERVED_ATTRIBUTES,
  classifyMutations,
  isColorAdaptOwnedMutation,
  type ClassifiedMutation,
} from '@features/dynamic-analysis';

/** Records exactly as production would receive them (same subscription options). */
function recordMutations(
  mutate: () => void,
  options: { unfiltered?: boolean } = {},
): MutationRecord[] {
  const observer = new MutationObserver(() => undefined);
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    ...(options.unfiltered ? {} : { attributeFilter: [...OBSERVED_ATTRIBUTES] }),
    attributeOldValue: true,
    characterData: true,
    characterDataOldValue: true,
  });
  const rootOptions = { attributes: true, attributeOldValue: true };
  observer.observe(document.documentElement, rootOptions);
  if (document.body) observer.observe(document.body, rootOptions);
  mutate();
  const records = observer.takeRecords();
  observer.disconnect();
  return records;
}

function classify(mutate: () => void, options?: { unfiltered?: boolean }) {
  return classifyMutations(recordMutations(mutate, options), { doc: document });
}

function kinds(mutations: readonly ClassifiedMutation[]): string[] {
  return mutations.map((mutation) => mutation.kind);
}

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
});

describe('node mutations', () => {
  it('classifies an added element as NODE_ADDED and a removed one as NODE_REMOVED', () => {
    document.body.innerHTML = '<div id="host"><p id="gone">x</p></div>';
    const added = document.createElement('p');
    const { mutations } = classify(() => {
      document.getElementById('host')!.appendChild(added);
      document.getElementById('gone')!.remove();
    });
    expect(kinds(mutations)).toEqual(['NODE_ADDED', 'NODE_REMOVED']);
    expect(mutations[0]).toMatchObject({ element: added });
  });

  it('treats scripts, templates and meta tags as irrelevant', () => {
    const { mutations, counts } = classify(() => {
      document.body.append(document.createElement('script'), document.createElement('template'));
    });
    expect(kinds(mutations)).toEqual(['IRRELEVANT', 'IRRELEVANT']);
    expect(counts.IRRELEVANT).toBe(2);
  });

  it('classifies text added to or removed from an element as TEXT_CHANGE on that element', () => {
    document.body.innerHTML = '<p id="p"></p>';
    const p = document.getElementById('p')!;
    const { mutations } = classify(() => {
      p.textContent = 'hello';
    });
    expect(kinds(mutations)).toEqual(['TEXT_CHANGE']);
    expect(mutations[0]).toMatchObject({ element: p });
  });

  it('a stylesheet inside an added subtree makes the whole mutation a stylesheet change', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const card = document.createElement('div');
    card.innerHTML = '<p>x</p><style>.a{color:red}</style>';
    const { mutations } = classify(() => document.getElementById('host')!.appendChild(card));
    expect(kinds(mutations)).toEqual(['STYLESHEET_CHANGE']);
  });
});

describe('attribute mutations', () => {
  it.each(['class', 'hidden', 'disabled', 'aria-disabled', 'role'])(
    '%s on an element is style-affecting',
    (attribute) => {
      document.body.innerHTML = '<button id="b" class="a">x</button>';
      const { mutations } = classify(() => {
        document.getElementById('b')!.setAttribute(attribute, attribute === 'class' ? 'b' : 'x');
      });
      expect(kinds(mutations)).toEqual(['STYLE_AFFECTING_ATTRIBUTE']);
    },
  );

  it('style changes count only when a property ColorAdapt reads changed', () => {
    document.body.innerHTML = '<div id="d" style="color: red"></div>';
    const d = document.getElementById('d')!;
    expect(kinds(classify(() => d.style.setProperty('transform', 'none')).mutations)).toEqual([
      'IRRELEVANT',
    ]);
    expect(
      kinds(classify(() => d.style.setProperty('background-color', 'blue')).mutations),
    ).toEqual(['STYLE_AFFECTING_ATTRIBUTE']);
    expect(kinds(classify(() => d.style.setProperty('--brand', 'blue')).mutations)).toEqual([
      'STYLE_AFFECTING_ATTRIBUTE',
    ]);
  });

  it('judges repeated changes to one attribute once, on the net change', () => {
    document.body.innerHTML = '<p id="p" class="a">x</p>';
    const p = document.getElementById('p')!;
    const net = classify(() => {
      p.className = 'b';
      p.className = 'c';
      p.className = 'a';
    });
    expect(kinds(net.mutations)).toEqual(['IRRELEVANT', 'IRRELEVANT', 'IRRELEVANT']);

    const changed = classify(() => {
      p.className = 'b';
      p.className = 'c';
    });
    expect(kinds(changed.mutations)).toEqual(['STYLE_AFFECTING_ATTRIBUTE', 'IRRELEVANT']);
  });

  it('class reordering is not a change', () => {
    document.body.innerHTML = '<p id="p" class="a b">x</p>';
    const { mutations } = classify(() => {
      document.getElementById('p')!.className = 'b a';
    });
    expect(kinds(mutations)).toEqual(['IRRELEVANT']);
  });

  it('unrelated attributes are never delivered, and data-* is not special', () => {
    document.body.innerHTML = '<p id="p">x</p>';
    const records = recordMutations(() => {
      const p = document.getElementById('p')!;
      p.setAttribute('data-anything', '1');
      p.setAttribute('title', 't');
      p.setAttribute('aria-label', 'l');
    });
    expect(records).toHaveLength(0);
  });

  it('even if delivered, an unobserved attribute classifies as irrelevant', () => {
    document.body.innerHTML = '<p id="p">x</p>';
    const { mutations } = classify(
      () => document.getElementById('p')!.setAttribute('data-anything', '1'),
      { unfiltered: true },
    );
    expect(kinds(mutations)).toEqual(['IRRELEVANT']);
  });

  it('a theme attribute on <html> is style-affecting, other root attributes are not', () => {
    const theme = classify(() => document.documentElement.setAttribute('data-theme', 'dark'));
    expect(kinds(theme.mutations)).toEqual(['STYLE_AFFECTING_ATTRIBUTE']);
    expect(theme.mutations[0]).toMatchObject({ element: document.documentElement });

    const other = classify(() => document.documentElement.setAttribute('data-scroll', '1'));
    expect(kinds(other.mutations)).toEqual(['IRRELEVANT']);
  });
});

describe('character data', () => {
  it('only an empty/non-empty switch matters', () => {
    document.body.innerHTML = '<p id="p">hello</p>';
    const text = document.getElementById('p')!.firstChild as Text;
    expect(kinds(classify(() => (text.data = 'other')).mutations)).toEqual(['IRRELEVANT']);
    expect(kinds(classify(() => (text.data = '  ')).mutations)).toEqual(['TEXT_CHANGE']);
    expect(kinds(classify(() => (text.data = 'back')).mutations)).toEqual(['TEXT_CHANGE']);
  });

  it('text inside a page <style> is a stylesheet change', () => {
    document.head.innerHTML = '<style id="s">.a{color:red}</style>';
    const text = document.getElementById('s')!.firstChild as Text;
    expect(kinds(classify(() => (text.data = '.a{color:blue}')).mutations)).toEqual([
      'STYLESHEET_CHANGE',
    ]);
  });
});

describe('stylesheet mutations', () => {
  it('adding or removing a <style> / <link rel=stylesheet> is a stylesheet change', () => {
    const style = document.createElement('style');
    expect(kinds(classify(() => document.head.appendChild(style)).mutations)).toEqual([
      'STYLESHEET_CHANGE',
    ]);
    expect(kinds(classify(() => style.remove()).mutations)).toEqual(['STYLESHEET_CHANGE']);
  });

  it('a link that has not loaded yet is reported as pending', () => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://example.invalid/a.css';
    const { mutations } = classify(() => document.head.appendChild(link));
    expect(mutations[0]).toMatchObject({ kind: 'STYLESHEET_CHANGE', pendingLink: link });
  });

  const stylesheetLink = (href = 'https://example.invalid/a.css'): HTMLLinkElement => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    if (href) link.href = href;
    return link;
  };
  const withSheet = (link: HTMLLinkElement) =>
    Object.defineProperty(link, 'sheet', { value: {}, configurable: true });

  it('a link removed from the document is a plain stylesheet change, never a load to wait for', () => {
    const link = stylesheetLink();
    document.head.appendChild(link);
    const { mutations } = classify(() => link.remove());
    expect(mutations).toEqual([{ kind: 'STYLESHEET_CHANGE' }]); // removed links have no sheet either
  });

  it('a link inside a removed subtree is a plain stylesheet change too', () => {
    const wrapper = document.createElement('div');
    wrapper.appendChild(stylesheetLink());
    document.body.appendChild(wrapper);
    const { mutations } = classify(() => wrapper.remove());
    expect(mutations).toEqual([{ kind: 'STYLESHEET_CHANGE' }]);
  });

  it('disabling a link removes its rules at once: not pending', () => {
    const link = stylesheetLink();
    document.head.appendChild(link);
    const { mutations } = classify(() => link.setAttribute('disabled', ''));
    expect(mutations).toEqual([{ kind: 'STYLESHEET_CHANGE' }]);
  });

  it('re-enabling a link (it has no sheet until it loads again) is pending', () => {
    const link = stylesheetLink();
    link.setAttribute('disabled', '');
    document.head.appendChild(link);
    const { mutations } = classify(() => link.removeAttribute('disabled'));
    expect(mutations[0]).toMatchObject({ kind: 'STYLESHEET_CHANGE', pendingLink: link });
  });

  it('an href change is pending even though the old sheet is still attached', () => {
    const link = withSheet(stylesheetLink());
    document.head.appendChild(link);
    const { mutations } = classify(() =>
      link.setAttribute('href', 'https://example.invalid/b.css'),
    );
    expect(mutations[0]).toMatchObject({ kind: 'STYLESHEET_CHANGE', pendingLink: link });
  });

  it('a media change on a loaded link is immediate (nothing to wait for)', () => {
    const link = withSheet(stylesheetLink());
    document.head.appendChild(link);
    const { mutations } = classify(() => link.setAttribute('media', 'print'));
    expect(mutations).toEqual([{ kind: 'STYLESHEET_CHANGE' }]);
  });

  it('a link with no href never fetches, so it is not pending', () => {
    const link = stylesheetLink('');
    const { mutations } = classify(() => document.head.appendChild(link));
    expect(mutations).toEqual([{ kind: 'STYLESHEET_CHANGE' }]);
  });

  it('every stylesheet in an added subtree counts, and content is not held back by pending links', () => {
    const wrapper = document.createElement('div');
    const a = stylesheetLink('https://example.invalid/a.css');
    const b = stylesheetLink('https://example.invalid/b.css');
    wrapper.append(a, b, document.createElement('p'));
    const { mutations } = classify(() => document.body.appendChild(wrapper));
    expect(mutations).toEqual([
      { kind: 'STYLESHEET_CHANGE', pendingLink: a },
      { kind: 'STYLESHEET_CHANGE', pendingLink: b },
      { kind: 'NODE_ADDED', element: wrapper },
    ]);
  });

  it('a subtree with a style next to a pending link is one rescan (it covers everything)', () => {
    const wrapper = document.createElement('div');
    wrapper.append(stylesheetLink(), document.createElement('style'), document.createElement('p'));
    const { mutations } = classify(() => document.body.appendChild(wrapper));
    expect(kinds(mutations)).toEqual(['STYLESHEET_CHANGE', 'STYLESHEET_CHANGE']);
  });

  it('a non-stylesheet <link> is not a stylesheet change', () => {
    const link = document.createElement('link');
    link.rel = 'icon';
    const { mutations } = classify(() => document.head.appendChild(link));
    expect(kinds(mutations)).toEqual(['NODE_ADDED']);
  });
});

describe('ColorAdapt-owned mutations', () => {
  it('its own <style> element and everything inside it is internal', () => {
    const style = document.createElement('style');
    style.id = 'coloradapt-stylesheet';
    const records = recordMutations(() => {
      document.head.appendChild(style);
      style.textContent = '/* a */';
      style.textContent = '/* b */';
      style.remove();
    });
    expect(records.length).toBeGreaterThan(0);
    expect(records.every(isColorAdaptOwnedMutation)).toBe(true);
    const { mutations, counts } = classifyMutations(records, { doc: document });
    expect(counts.COLORADAPT_INTERNAL).toBe(records.length);
    expect(mutations.some((m) => m.kind === 'COLORADAPT_INTERNAL' && m.stylesheetRemoved)).toBe(
      true,
    );
  });

  it('the targeting attribute is internal even when the subscription would deliver it', () => {
    document.body.innerHTML = '<p id="p">x</p>';
    const records = recordMutations(
      () => document.getElementById('p')!.setAttribute('data-coloradapt-id', 'ca-1'),
      { unfiltered: true },
    );
    expect(records).toHaveLength(1);
    expect(isColorAdaptOwnedMutation(records[0]!)).toBe(true);
  });

  it('a page element that merely resembles ours is not internal', () => {
    const imposter = document.createElement('div');
    imposter.id = 'coloradapt-stylesheet';
    const records = recordMutations(() => document.body.appendChild(imposter));
    expect(records.some(isColorAdaptOwnedMutation)).toBe(false);
  });

  it('a single record that adds our <style> together with a page node is not internal', () => {
    const style = document.createElement('style');
    style.id = 'coloradapt-stylesheet';
    const fragment = document.createDocumentFragment();
    fragment.append(style, document.createElement('div'));
    const records = recordMutations(() => document.body.appendChild(fragment));
    expect(records).toHaveLength(1);
    expect(isColorAdaptOwnedMutation(records[0]!)).toBe(false);
  });
});
