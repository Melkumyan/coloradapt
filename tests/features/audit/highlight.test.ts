import { afterEach, describe, expect, it } from 'vitest';
import { AuditHighlighter, AuditStore, LocatorContext } from '@features/audit';
import { buildSnapshot } from '@core/audit';
import { microtasks } from '../dynamic/helpers';
import { candidate, target } from '../../core/audit/builders';
import { $, DEUTAN, mountAudit } from './kit';

const OVERLAY = '[data-coloradapt-audit-overlay]';
const CSS = '.low { color: #aaaaaa; background-color: #ffffff; }';
const ROWS = Array.from({ length: 5 }, (_, i) => `<p id="r${i}" class="low">row ${i}</p>`).join('');

afterEach(() => {
  document.querySelectorAll(OVERLAY).forEach((box) => box.remove());
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

describe('the highlighter', () => {
  it('draws one fixed, click-through box on the document element and leaves the element alone', () => {
    document.body.innerHTML = '<p id="p" class="x" style="color: red">hello</p>';
    const p = $('#p');
    const before = p.outerHTML;
    const highlighter = new AuditHighlighter(document);
    expect(highlighter.show(p)).toBe(true);
    const box = document.querySelector<HTMLElement>(OVERLAY)!;
    expect(box.parentElement).toBe(document.documentElement);
    expect(box.style.position).toBe('fixed');
    expect(box.style.pointerEvents).toBe('none');
    expect(box.getAttribute('aria-hidden')).toBe('true');
    expect(box.textContent).toBe('');
    expect(p.outerHTML).toBe(before); // nothing was written to the page's own node
    expect(document.body.children).toHaveLength(1); // nor was anything added to the body
    highlighter.hide();
  });

  it('never has more than one box, however often it is told to show', () => {
    document.body.innerHTML = '<p id="a">a</p><p id="b">b</p>';
    const highlighter = new AuditHighlighter(document);
    highlighter.show($('#a'));
    highlighter.show($('#b'));
    highlighter.show($('#a'));
    expect(document.querySelectorAll(OVERLAY)).toHaveLength(1);
    expect(highlighter.target?.id).toBe('a');
  });

  it('follows the element: moves to another, and clears when it is removed or when hidden', () => {
    document.body.innerHTML = '<p id="a">a</p><p id="b">b</p>';
    const highlighter = new AuditHighlighter(document);
    highlighter.show($('#a'));
    highlighter.show($('#b'));
    expect(highlighter.target?.id).toBe('b');
    $('#b').remove();
    highlighter.refresh();
    expect(document.querySelector(OVERLAY)).toBeNull();
    expect(highlighter.target).toBeNull();
    highlighter.show($('#a'));
    highlighter.hide();
    expect(document.querySelector(OVERLAY)).toBeNull();
    expect(highlighter.visible).toBe(false);
  });

  it('refuses an element that is not in the document, and clears whatever was shown', () => {
    document.body.innerHTML = '<p id="a">a</p>';
    const highlighter = new AuditHighlighter(document);
    highlighter.show($('#a'));
    expect(highlighter.show(document.createElement('p'))).toBe(false);
    expect(document.querySelector(OVERLAY)).toBeNull();
  });

  it('scrolls only when asked, and never moves focus', () => {
    document.body.innerHTML = '<button id="focus">f</button><p id="a">a</p>';
    let scrolled = 0;
    $('#a').scrollIntoView = () => {
      scrolled += 1;
    };
    $('#focus').focus();
    const highlighter = new AuditHighlighter(document);
    highlighter.show($('#a'), false);
    expect(scrolled).toBe(0);
    highlighter.show($('#a'), true);
    expect(scrolled).toBe(1);
    expect(document.activeElement?.id).toBe('focus');
  });

  it('removes its listeners with the box', () => {
    document.body.innerHTML = '<p id="a">a</p>';
    const live = new Map<string, Set<unknown>>();
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    window.addEventListener = ((type: string, listener: unknown, ...rest: unknown[]) => {
      if (!live.has(type)) live.set(type, new Set());
      live.get(type)!.add(listener);
      return (add as (...args: unknown[]) => void)(type, listener, ...rest);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((type: string, listener: unknown, ...rest: unknown[]) => {
      live.get(type)?.delete(listener);
      return (remove as (...args: unknown[]) => void)(type, listener, ...rest);
    }) as typeof window.removeEventListener;
    try {
      const highlighter = new AuditHighlighter(document);
      highlighter.show($('#a'));
      highlighter.show($('#a'));
      expect(live.get('scroll')?.size).toBe(1); // re-showing does not stack listeners
      expect(live.get('resize')?.size).toBe(1);
      highlighter.hide();
    } finally {
      window.addEventListener = add;
      window.removeEventListener = remove;
    }
    expect(live.get('scroll')?.size).toBe(0);
    expect(live.get('resize')?.size).toBe(0);
  });
});

describe('the highlight is ColorAdapt’s own and is ignored by every layer', () => {
  it('does not start a dynamic pass, and is not part of any analysis or audit', async () => {
    const rig = mountAudit(ROWS, { css: CSS, settings: DEUTAN, adapt: true });
    const finding = rig.run().findings[0]!;
    await microtasks();
    rig.dynamicScheduler.runFrame();
    const before = rig.content.dynamic.diagnostics();
    rig.audit.highlight({ findingId: finding.id, index: 0, scroll: false });
    $('#r0').scrollIntoView?.();
    await microtasks();
    expect(rig.dynamicScheduler.pending).toBe(0);
    rig.content.dynamic.flush();
    const after = rig.content.dynamic.diagnostics();
    expect(after.incrementalPasses).toBe(before.incrementalPasses);
    expect(after.fullRescans).toBe(before.fullRescans);
    // The audit with the box on screen is the audit without it.
    const again = rig.run();
    expect(again.findings.map((f) => f.id)).toEqual([finding.id]);
    expect(again.findings[0]?.affectedCount).toBe(5);
  });

  it('is not reported by an audit running while it is drawn', () => {
    const rig = mountAudit(ROWS, { css: CSS, settings: DEUTAN });
    const finding = rig.run().findings[0]!;
    rig.audit.highlight({ findingId: finding.id, index: 1, scroll: false });
    const snapshot = rig.run();
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain('coloradapt-audit-overlay');
  });
});

describe('highlighting through the controller', () => {
  it('addresses every element of a finding, wraps around, and reports the position', () => {
    const rig = mountAudit(ROWS, { css: CSS, settings: DEUTAN });
    const finding = rig.run().findings[0]!;
    expect(finding.affectedCount).toBe(5);
    const at = (index: number) =>
      rig.audit.highlight({ findingId: finding.id, index, scroll: false });
    expect(at(0)).toMatchObject({ ok: true, index: 0, count: 5 });
    const second = at(1);
    expect(second.ok && second.locator?.path).toBe('#r1');
    expect(at(5)).toMatchObject({ ok: true, index: 0 }); // wraps forward
    expect(at(-1)).toMatchObject({ ok: true, index: 4 }); // and backward
    expect(document.querySelectorAll(OVERLAY)).toHaveLength(1);
  });

  it('highlights beyond the listed sample', () => {
    const many = Array.from({ length: 80 }, (_, i) => `<p id="m${i}" class="low">m</p>`).join('');
    const rig = mountAudit(many, { css: CSS, settings: DEUTAN });
    const finding = rig.run().findings[0]!;
    expect(finding.affected).toHaveLength(50);
    expect(finding.affectedCount).toBe(80);
    expect(rig.audit.highlight({ findingId: finding.id, index: 79, scroll: false })).toMatchObject({
      ok: true,
      count: 80,
    });
  });

  it('says so when the finding or the element is gone, and leaves no stale box', () => {
    const rig = mountAudit(ROWS, { css: CSS, settings: DEUTAN });
    const finding = rig.run().findings[0]!;
    expect(
      rig.audit.highlight({ findingId: 'CA-NOPE-001:0000000000000000', index: 0, scroll: false }),
    ).toEqual({
      ok: false,
      reason: 'unknown-finding',
      count: 0,
    });
    $('#r0').remove();
    expect(rig.audit.highlight({ findingId: finding.id, index: 0, scroll: false })).toMatchObject({
      ok: false,
      reason: 'gone',
    });
    expect(document.querySelector(OVERLAY)).toBeNull();
  });

  it('is cleared by clearHighlight and by close', () => {
    const rig = mountAudit(ROWS, { css: CSS, settings: DEUTAN });
    const finding = rig.run().findings[0]!;
    rig.audit.highlight({ findingId: finding.id, index: 0, scroll: false });
    rig.audit.clearHighlight();
    expect(document.querySelector(OVERLAY)).toBeNull();
    rig.audit.highlight({ findingId: finding.id, index: 0, scroll: false });
    rig.audit.close();
    expect(document.querySelector(OVERLAY)).toBeNull();
  });
});

describe('the store', () => {
  const snapshotAt = (generation: number) =>
    buildSnapshot({
      candidates: [candidate({ target: target('html>body>p:nth-of-type(1)', 'p') })],
      generation,
      timestamp: 0,
      page: { origin: 'https://example.test', pathname: '/' },
      extensionVersion: '0',
      settings: { activeProfile: 'normal', auditedProfiles: [], adaptationEnabled: false },
      coverage: {
        elementsAnalyzed: 0,
        analysisTruncated: false,
        semanticCandidates: 0,
        svgUnits: 0,
        charts: 0,
        canvases: 0,
        images: 0,
      },
    });

  it('refuses a snapshot that is not newer than the current one', () => {
    const store = new AuditStore();
    const newer = snapshotAt(5);
    const older = snapshotAt(3);
    expect(store.commit(newer.snapshot, newer.members, new Map())).toBe(true);
    expect(store.commit(older.snapshot, older.members, new Map())).toBe(false);
    expect(store.commit(newer.snapshot, newer.members, new Map())).toBe(false);
    expect(store.snapshot?.generation).toBe(5);
  });

  it('hands out strictly increasing generations', () => {
    const store = new AuditStore();
    expect([store.nextGeneration(), store.nextGeneration(), store.nextGeneration()]).toEqual([
      1, 2, 3,
    ]);
  });

  it('resolves live elements, and nothing for a disconnected one', () => {
    document.body.innerHTML = '<p id="p">x</p>';
    const p = $('#p');
    const built = snapshotAt(1);
    const id = built.members.get(built.snapshot.findings[0]!.id)![0]!;
    const store = new AuditStore();
    store.commit(built.snapshot, built.members, new Map([[id, p]]));
    const findingId = built.snapshot.findings[0]!.id;
    expect(store.elementAt(findingId, 0)).toBe(p);
    expect(store.count(findingId)).toBe(1);
    p.remove();
    expect(store.elementAt(findingId, 0)).toBeNull();
    expect(store.elementAt(findingId, 7)).toBeNull();
    store.clear();
    expect(store.snapshot).toBeNull();
    expect(store.count(findingId)).toBe(0);
  });
});

describe('element identity', () => {
  it('is the same for the same place whatever the classes, text or state', () => {
    document.body.innerHTML = '<ul id="list"><li class="a">one</li><li class="b">two</li></ul>';
    const ids = (ctx: LocatorContext) =>
      [...document.querySelectorAll('li')].map((li) => ctx.describe(li).key);
    const before = ids(new LocatorContext(document));
    document.querySelectorAll('li').forEach((li) => {
      li.className = 'completely different state';
      li.textContent = 'changed';
    });
    expect(ids(new LocatorContext(document))).toEqual(before);
    expect(before[0]).toBe('#list>li:nth-of-type(1)');
  });

  it('anchors at the nearest unique id and not at a duplicated one', () => {
    document.body.innerHTML = '<div id="dup"><p>a</p></div><div id="dup"><p id="x">b</p></div>';
    const second = document.querySelectorAll('div')[1]!;
    expect(new LocatorContext(document).describe(second.querySelector('p')!).key).toBe('#x');
    const firstP = document.querySelectorAll('div')[0]!.querySelector('p')!;
    expect(new LocatorContext(document).describe(firstP).key).toBe('#dup>p:nth-of-type(1)');
  });

  it('shows a short path and keeps the full one as identity', () => {
    document.body.innerHTML =
      '<div><div><div><div><div><div><div><span class="deep">x</span></div></div></div></div></div></div></div>';
    const ctx = new LocatorContext(document);
    const described = ctx.describe(document.querySelector('.deep')!);
    expect(described.locator.path.split('>').length).toBeLessThanOrEqual(7);
    expect(described.key.split('>').length).toBeGreaterThan(7);
  });

  it('names a component by tag, role, input type and a few class names, not by row numbers', () => {
    document.body.innerHTML = '<input class="field row-17 big" type="email" role="textbox">';
    const described = new LocatorContext(document).describe(document.querySelector('input')!);
    expect(described.component).toBe('input[textbox]:email.big.field');
  });
});
