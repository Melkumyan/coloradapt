import { describe, expect, it } from 'vitest';
import type { AuditSnapshot } from '@core/audit';
import { AUDIT_WATCH } from '@features/audit';
import { createChartEnvironment, lineChartSvg } from '../charts/engine';
import { microtasks } from '../dynamic/helpers';
import { $, DEUTAN, findingsOf, mountAudit } from './kit';

const CSS = `
  .low { color: #aaaaaa; background-color: #ffffff; }
  .fine { color: #000000; background-color: #ffffff; }
  .f { border-top-style: solid; border-top-width: 1px; border-top-color: #888888; }
  .f[aria-invalid="true"] { border-top-color: #c0392b; }
`;

const open = (markup: string) => {
  const rig = mountAudit(markup, {
    css: CSS,
    chartEnv: createChartEnvironment(document),
    settings: DEUTAN,
  });
  const seen: AuditSnapshot[] = [];
  rig.run();
  rig.audit.open((snapshot) => seen.push(snapshot));
  return { rig, seen };
};

/** The page changes; the session notices; the debounce elapses; a fresh snapshot arrives. */
async function settle(
  rig: ReturnType<typeof mountAudit>,
  seen: AuditSnapshot[],
): Promise<AuditSnapshot> {
  await microtasks();
  expect(rig.audited.pending).toBe(1);
  const before = seen.length;
  rig.audited.fire();
  expect(seen.length).toBe(before + 1);
  return seen[seen.length - 1] as AuditSnapshot;
}

const paths = (snapshot: AuditSnapshot, rule: string) =>
  findingsOf(snapshot, rule).flatMap((f) => f.affected.map((a) => a.locator.path));

describe('a live audit session', () => {
  it('costs nothing until it is asked: no pass without a run', () => {
    const rig = mountAudit('<p class="low">x</p>', { css: CSS });
    expect(rig.reads()).toBe(0);
    expect(rig.audit.snapshot).toBeNull();
    expect(rig.audit.watching).toBe(false);
  });

  it('does not re-audit for ColorAdapt’s own writes (ids, injected style)', async () => {
    const { rig } = open('<p id="a" class="low">x</p>');
    rig.adapt();
    await microtasks();
    expect(rig.audited.pending).toBe(0);
  });

  it('a problem that appears gets a finding; one that is fixed loses it; one that is removed loses it', async () => {
    const { rig, seen } = open('<p id="a" class="fine">ok</p><div id="host"></div>');
    expect(findingsOf(rig.audit.snapshot!, 'CA-COLOR-001')).toEqual([]);

    const added = document.createElement('p');
    added.id = 'b';
    added.className = 'low';
    added.textContent = 'new and pale';
    $('#host').append(added);
    let snapshot = await settle(rig, seen);
    expect(paths(snapshot, 'CA-COLOR-001')).toEqual(['#b']);

    added.className = 'fine';
    snapshot = await settle(rig, seen);
    expect(findingsOf(snapshot, 'CA-COLOR-001')).toEqual([]);

    added.className = 'low';
    snapshot = await settle(rig, seen);
    expect(paths(snapshot, 'CA-COLOR-001')).toEqual(['#b']);
    added.remove();
    snapshot = await settle(rig, seen);
    expect(snapshot.findings).toEqual([]);
  });

  it('a chart that is inserted gets audited', async () => {
    const { rig, seen } = open('<div id="host"></div>');
    $('#host').insertAdjacentHTML('beforeend', lineChartSvg(['#d62728', '#2ca02c', '#ff7f0e']));
    const snapshot = await settle(rig, seen);
    expect(findingsOf(snapshot, 'CA-CHART-001')).toHaveLength(1);
  });

  it('a burst of changes is one pass', async () => {
    const { rig, seen } = open('<div id="host"></div>');
    const passes = rig.audit.diagnostics().auditPasses;
    for (let i = 0; i < 200; i += 1) {
      const p = document.createElement('p');
      p.className = 'low';
      p.textContent = `row ${i}`;
      $('#host').append(p);
    }
    const snapshot = await settle(rig, seen);
    expect(rig.audit.diagnostics().auditPasses).toBe(passes + 1);
    expect(snapshot.findings[0]?.affectedCount).toBe(200);
    expect(snapshot.findings).toHaveLength(1);
  });

  it('spaces passes out: the wait never drops below the minimum interval after a pass', () => {
    expect(AUDIT_WATCH.minIntervalMs).toBeGreaterThanOrEqual(AUDIT_WATCH.debounceMs);
  });

  it('points a finding at the new node when an equivalent one replaces the old', async () => {
    const { rig, seen } = open('<div id="host"><section><p class="low">pale</p></section></div>');
    const first = rig.audit.snapshot!.findings[0]!;
    const old = $('#host p');
    expect(rig.audit.highlight({ findingId: first.id, index: 0, scroll: false }).ok).toBe(true);
    expect(rig.audit.diagnostics().auditHighlightVisible).toBe(true);

    const replacement = old.cloneNode(true) as HTMLElement;
    old.replaceWith(replacement);
    const snapshot = await settle(rig, seen);
    expect(snapshot.findings[0]?.id).toBe(first.id); // same place, same problem: same id
    const result = rig.audit.highlight({ findingId: first.id, index: 0, scroll: false });
    expect(result.ok).toBe(true);
    expect(rig.audit.diagnostics().auditHighlightVisible).toBe(true);
    expect(old.isConnected).toBe(false);
  });

  it('stays open across passes and ends cleanly: no observer, no timer, no highlight', async () => {
    const { rig } = open('<p id="a" class="low">x</p>');
    const first = rig.audit.snapshot!.findings[0]!;
    rig.audit.highlight({ findingId: first.id, index: 0, scroll: false });
    document.body.append(document.createElement('p'));
    await microtasks();
    expect(rig.audited.pending).toBe(1);
    rig.audit.close();
    expect(rig.audit.watching).toBe(false);
    expect(rig.audited.pending).toBe(0);
    expect(document.querySelector('[data-coloradapt-audit-overlay]')).toBeNull();
    document.body.append(document.createElement('p'));
    await microtasks();
    expect(rig.audited.pending).toBe(0);
  });
});

describe('single-page navigation', () => {
  it('clears the old route’s findings and audits the new route', async () => {
    const { rig, seen } = open('<p id="old" class="low">old page</p>');
    expect(paths(rig.audit.snapshot!, 'CA-COLOR-001')).toEqual(['#old']);
    expect(rig.audit.snapshot!.page.pathname).toBe('/account');
    const first = rig.audit.snapshot!.findings[0]!;
    rig.audit.highlight({ findingId: first.id, index: 0, scroll: false });

    rig.setUrl('https://example.test/settings?tab=2#x');
    document.body.innerHTML =
      '<p id="new" class="fine">readable</p><input id="e" class="f" aria-invalid="true" aria-label="E"><input class="f" aria-label="F"><input class="f" aria-label="G">';
    const snapshot = await settle(rig, seen); // a route change is a DOM change: the observer notices it
    expect(document.querySelector('[data-coloradapt-audit-overlay]')).toBeNull(); // gone with the route
    expect(snapshot.page).toEqual({ origin: 'https://example.test', pathname: '/settings' });
    expect(findingsOf(snapshot, 'CA-COLOR-001')).toEqual([]);
    expect(paths(snapshot, 'CA-SEM-001')).toEqual(['#e']);
    expect(JSON.stringify(snapshot)).not.toMatch(/#old|tab=2/);
  });
});

describe('snapshot generations', () => {
  it('advance with every pass and are never reused', () => {
    const rig = mountAudit('<p class="low">x</p>', { css: CSS });
    const a = rig.run().generation;
    const b = rig.run().generation;
    const c = rig.run().generation;
    expect([a, b, c]).toEqual([1, 2, 3]);
  });

  it('give an unchanged page the same finding ids on every refresh', () => {
    const rig = mountAudit(
      '<p class="low">a</p><p class="low">b</p><input class="f" aria-invalid="true" aria-label="E"><input class="f" aria-label="F"><input class="f" aria-label="G">',
      { css: CSS, settings: DEUTAN },
    );
    const ids = Array.from({ length: 10 }, () =>
      rig
        .run()
        .findings.map((f) => f.id)
        .join(','),
    );
    expect(new Set(ids).size).toBe(1);
    const instances = Array.from({ length: 10 }, () =>
      rig
        .run()
        .findings.flatMap((f) => f.affected.map((a) => a.instanceId))
        .join(','),
    );
    expect(new Set(instances).size).toBe(1);
  });
});
