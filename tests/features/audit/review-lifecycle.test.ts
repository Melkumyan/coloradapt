import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditHighlighter, AUDIT_WATCH } from '@features/audit';
import type { AuditSnapshot } from '@core/audit';
import { createAuditReport, renderAuditHtml, serializeAuditReport } from '@core/audit';
import { microtasks } from '../dynamic/helpers';
import { $, DEUTAN, findingsOf, mountAudit } from './kit';

const OVERLAY = '[data-coloradapt-audit-overlay]';
const CSS = `.low { color: #aaaaaa; background-color: #ffffff; } .fine { color: #000; background-color: #fff; }`;
const ROWS = (n: number) =>
  `<ul id="rows">${Array.from({ length: n }, (_, i) => `<li id="r${i}" class="low">row ${i}</li>`).join('')}</ul>`;

afterEach(() => {
  document.querySelectorAll(OVERLAY).forEach((box) => box.remove());
  delete (Element.prototype as { checkVisibility?: unknown }).checkVisibility;
  vi.restoreAllMocks();
});

const open = (markup: string) => {
  const rig = mountAudit(markup, { css: CSS, settings: DEUTAN });
  const seen: AuditSnapshot[] = [];
  rig.run();
  rig.audit.open((s) => seen.push(s));
  return { rig, seen };
};

describe('highlight under DOM churn', () => {
  it('a hidden target draws no orphan box; it returns when the target is shown again', () => {
    const calls: boolean[] = [];
    (Element.prototype as { checkVisibility?: () => boolean }).checkVisibility = function () {
      const shown = (this as HTMLElement).style.display !== 'none';
      calls.push(shown);
      return shown;
    };
    document.body.innerHTML = '<p id="p">x</p>';
    const highlighter = new AuditHighlighter(document);
    highlighter.show($('#p'));
    expect(highlighter.visible).toBe(true);
    $('#p').style.display = 'none';
    highlighter.refresh();
    expect(highlighter.visible).toBe(false);
    expect(document.querySelector<HTMLElement>(OVERLAY)?.style.display).toBe('none');
    $('#p').style.display = '';
    highlighter.refresh();
    expect(highlighter.visible).toBe(true);
    highlighter.hide();
    expect(document.querySelector(OVERLAY)).toBeNull();
  });

  it('a moved target is followed (its box is re-placed), a replaced one clears the box', () => {
    document.body.innerHTML = '<div id="a"><p id="p">x</p></div><div id="b"></div>';
    const highlighter = new AuditHighlighter(document);
    const p = $('#p');
    const rects = vi.spyOn(p, 'getBoundingClientRect');
    highlighter.show(p);
    $('#b').append(p);
    highlighter.refresh();
    expect(rects.mock.calls.length).toBeGreaterThanOrEqual(2); // re-read after the move
    expect(highlighter.target).toBe(p);
    p.replaceWith(document.createElement('p'));
    highlighter.refresh();
    expect(document.querySelector(OVERLAY)).toBeNull();
    expect(highlighter.target).toBeNull();
  });

  it('scroll and resize only re-read the element: nothing of the page is written', () => {
    document.body.innerHTML = '<p id="p" class="c">x</p>';
    const p = $('#p');
    const before = document.body.innerHTML;
    const raf: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      raf.push(cb);
      return raf.length;
    });
    const highlighter = new AuditHighlighter(document);
    highlighter.show(p);
    for (let i = 0; i < 20; i += 1) window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    expect(raf).toHaveLength(1); // one update per frame however many events
    raf[0]?.(0);
    expect(document.body.innerHTML).toBe(before);
    highlighter.hide();
  });
});

describe('selected finding and live updates', () => {
  it('the selected finding disappears during a live pass: the highlight is removed, nothing throws', async () => {
    const { rig, seen } = open(ROWS(3));
    const id = findingsOf(rig.audit.snapshot!, 'CA-COLOR-001')[0]!.id;
    expect(rig.audit.highlight({ findingId: id, index: 0, scroll: false }).ok).toBe(true);
    expect(document.querySelectorAll(OVERLAY)).toHaveLength(1);
    for (const row of document.querySelectorAll('li')) row.className = 'fine';
    await microtasks();
    rig.audited.fire();
    expect(findingsOf(seen[seen.length - 1]!, 'CA-COLOR-001')).toEqual([]);
    expect(document.querySelectorAll(OVERLAY)).toHaveLength(0);
    expect(rig.audit.highlight({ findingId: id, index: 0, scroll: false }).ok).toBe(false);
  });

  it('an element of the finding disappears: highlighting it again lands on a live element, or says gone', async () => {
    const { rig, seen } = open(ROWS(3));
    const id = findingsOf(rig.audit.snapshot!, 'CA-COLOR-001')[0]!.id;
    $('#r0').remove();
    await microtasks();
    rig.audited.fire();
    const finding = findingsOf(seen[seen.length - 1]!, 'CA-COLOR-001')[0]!;
    expect(finding.id).toBe(id);
    expect(finding.affectedCount).toBe(2);
    for (let i = 0; i < 4; i += 1) {
      const result = rig.audit.highlight({ findingId: id, index: i, scroll: false });
      expect(result.ok).toBe(true);
      expect(document.querySelectorAll(OVERLAY)).toHaveLength(1);
    }
  });
});

describe('coalescing and exact timing contract (injected scheduler, no sleeps)', () => {
  it('a burst of mutations is one pass, and the last mutation is in it', async () => {
    const { rig, seen } = open(ROWS(2));
    const before = seen.length;
    for (let i = 0; i < 50; i += 1) {
      $('#r0').textContent = `change ${i}`;
      await microtasks();
    }
    expect(rig.audited.pending).toBe(1);
    $('#r1').className = 'fine'; // the very last mutation before the timer fires
    await microtasks();
    rig.audited.fire();
    expect(seen.length).toBe(before + 1);
    const paths = findingsOf(seen[seen.length - 1]!, 'CA-COLOR-001').flatMap((f) =>
      f.affected.map((a) => a.locator.id),
    );
    expect(paths).toEqual(['r0']);
  });

  it('waits at least the debounce, and at least the minimum interval since the last pass started', async () => {
    let now = 1_000_000;
    const delays: number[] = [];
    const timers = new Map<number, () => void>();
    let next = 1;
    const rig = mountAudit(ROWS(2), { css: CSS, settings: DEUTAN, now: () => now });
    // Re-create the controller with a recording scheduler (same sources, same page).
    const { AuditController } = await import('@features/audit');
    const audit = new AuditController({
      doc: document,
      sources: () => rig.content.auditSources({}),
      now: () => now,
      scheduler: {
        setTimeout(cb, ms) {
          delays.push(ms);
          timers.set(next, cb);
          return next++;
        },
        clearTimeout(h) {
          timers.delete(h);
        },
      },
      url: () => 'https://example.test/',
    });
    audit.run(DEUTAN, { scope: 'auto' });
    audit.open(() => undefined);
    now += 10_000; // long idle: only the debounce applies
    $('#r0').textContent = 'a';
    await microtasks();
    expect(delays.at(-1)).toBe(AUDIT_WATCH.debounceMs);
    for (const run of [...timers.values()]) run();
    timers.clear();
    now += 100; // right after a pass: the interval applies
    $('#r0').textContent = 'b';
    await microtasks();
    expect(delays.at(-1)).toBeGreaterThanOrEqual(AUDIT_WATCH.minIntervalMs - 100);
    audit.close();
  });
});

describe('observer, timer and session lifecycle', () => {
  it('open/close x100 leaves no observer, no timer, no highlight and no listener', async () => {
    let live = 0;
    let created = 0;
    const rig = mountAudit(ROWS(2), { css: CSS, settings: DEUTAN });
    const { AuditController } = await import('@features/audit');
    const audit = new AuditController({
      doc: document,
      sources: () => rig.content.auditSources({}),
      url: () => 'https://example.test/',
      createObserver: (callback) => {
        const real = new MutationObserver(callback);
        created += 1;
        live += 1;
        const disconnect = real.disconnect.bind(real);
        let ended = false;
        real.disconnect = () => {
          if (!ended) live -= 1;
          ended = true;
          disconnect();
        };
        return real;
      },
    });
    audit.run(DEUTAN, { scope: 'auto' });
    for (let i = 0; i < 100; i += 1) {
      audit.open(() => undefined);
      if (i % 5 === 0) {
        const id = audit.snapshot?.findings[0]?.id;
        if (id) audit.highlight({ findingId: id, index: 0, scroll: false });
        $('#r0').textContent = `x${i}`;
        await microtasks();
      }
      audit.close();
    }
    expect(created).toBe(100);
    expect(live).toBe(0);
    expect(audit.watching).toBe(false);
    expect(document.querySelectorAll(OVERLAY)).toHaveLength(0);
    expect(audit.diagnostics().auditWatching).toBe(false);
    expect(audit.diagnostics().auditHighlightVisible).toBe(false);
  });

  it('open twice is one observer; closed audit does no pass for page changes', async () => {
    const { rig } = open(ROWS(2));
    rig.audit.open(() => undefined);
    rig.audit.close();
    const reads = rig.reads();
    $('#r0').textContent = 'changed';
    await microtasks();
    expect(rig.audited.pending).toBe(0);
    expect(rig.reads()).toBe(reads);
  });
});

describe('export of one coherent generation', () => {
  it('an export built from a snapshot never contains findings of a newer pass', async () => {
    const { rig, seen } = open(ROWS(3));
    const held = rig.audit.snapshot!; // what the UI holds when the user presses "Export"
    for (const row of document.querySelectorAll('li')) row.className = 'fine';
    await microtasks();
    rig.audited.fire(); // a newer generation lands while the export is being made
    expect(seen[seen.length - 1]!.generation).toBeGreaterThan(held.generation);
    const report = createAuditReport(held, 1);
    expect(serializeAuditReport(report)).toContain(`"affectedCount": 3`);
    expect(report.findings.every((f) => f.affectedCount === 3)).toBe(true);
    expect(renderAuditHtml(report)).toContain('3 elements');
    // The newer one is a different, equally coherent snapshot.
    expect(createAuditReport(seen[seen.length - 1]!, 1).findings).toEqual([]);
  });
});
