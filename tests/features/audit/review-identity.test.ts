import { describe, expect, it } from 'vitest';
import type { AuditSnapshot } from '@core/audit';
import { $, DEUTAN, OFF, findingsOf, mountAudit } from './kit';

/**
 * Identity contract (docs/DEVELOPER_AUDIT.md, "Identity"):
 * - a finding (group) id is `rule : hash(component, region scope, context, assessment)`. It does not
 *   depend on how many elements are affected, where they are, or the order they appear in;
 * - an instance id is `rule / hash(structural path, context)`: best effort. An element with a
 *   component-like unique `id` is stable under any reorder; without one it is its position among
 *   same-tag siblings, so inserting or reordering same-tag siblings can move it. It never depends
 *   on classes, text or state, because those change exactly when a problem is fixed or appears.
 */
const CSS = `
  .low { color: #aaaaaa; background-color: #ffffff; }
  .fine { color: #000000; background-color: #ffffff; }
`;

const open = (markup: string, settings = DEUTAN) => mountAudit(markup, { css: CSS, settings });

const groupIds = (snapshot: AuditSnapshot, rule = 'CA-COLOR-001') =>
  findingsOf(snapshot, rule).map((f) => f.id);
const instanceIds = (snapshot: AuditSnapshot, rule = 'CA-COLOR-001') =>
  findingsOf(snapshot, rule)
    .flatMap((f) => f.affected.map((a) => a.instanceId))
    .sort();

const ROWS = (n: number) =>
  `<ul id="rows">${Array.from({ length: n }, (_, i) => `<li class="low">row ${i}</li>`).join('')}</ul>`;

describe('finding id stability under repeated audits', () => {
  it('refresh x20 gives byte-identical ids, with the audit opened and closed and adaptation toggled', () => {
    const rig = open(ROWS(4));
    const first = rig.run();
    const reference = JSON.stringify([groupIds(first), instanceIds(first)]);
    for (let i = 0; i < 20; i += 1) {
      if (i % 3 === 0) {
        rig.audit.open(() => undefined);
        rig.audit.close();
      }
      if (i === 7) rig.adapt();
      if (i === 14) rig.content.disableAdaptation();
      const snapshot = rig.run(i % 2 === 0 ? 'auto' : 'active');
      expect(JSON.stringify([groupIds(snapshot), instanceIds(snapshot)])).toBe(reference);
    }
  });

  it('profile scope changes do not rename a profile-independent finding', () => {
    const rig = open(ROWS(2));
    const a = groupIds(rig.run('active'));
    const b = groupIds(rig.run('major'));
    expect(b).toEqual(a);
  });

  it('adaptation ON and OFF produce the same ids', () => {
    const off = open(ROWS(3), OFF).run();
    document.body.innerHTML = '';
    const on = mountAudit(ROWS(3), { css: CSS, settings: DEUTAN, adapt: true }).run();
    expect(groupIds(on)).toEqual(groupIds(off));
    expect(instanceIds(on)).toEqual(instanceIds(off));
  });

  it('a count change keeps the group id (it is not part of the identity)', () => {
    const rig = open(ROWS(3));
    const before = groupIds(rig.run());
    $('#rows').append(Object.assign(document.createElement('li'), { className: 'low' }));
    $('#rows li:last-child').textContent = 'extra';
    const after = rig.run();
    expect(groupIds(after)).toEqual(before);
    expect(findingsOf(after, 'CA-COLOR-001')[0]?.affectedCount).toBe(4);
  });
});

describe('DOM churn', () => {
  const NAMED = `<ul id="rows">
    <li id="a" class="low">A</li><li id="b" class="low">B</li><li id="c" class="low">C</li></ul>`;

  it('reorder A,B,C -> C,A,B: group id stable; elements with an id keep their instance ids', () => {
    const rig = open(NAMED);
    const before = rig.run();
    const list = $('#rows');
    list.prepend($('#c'));
    const after = rig.run();
    expect(groupIds(after)).toEqual(groupIds(before));
    expect(instanceIds(after)).toEqual(instanceIds(before));
    expect(findingsOf(after, 'CA-COLOR-001')[0]?.affectedCount).toBe(3);
  });

  it('reorder without ids: the group id is stable; instance ids are the same set, permuted by position', () => {
    const rig = open(ROWS(3));
    const before = rig.run();
    const list = $('#rows');
    list.prepend(list.lastElementChild as Element);
    const after = rig.run();
    expect(groupIds(after)).toEqual(groupIds(before));
    // Position is the identity here (documented): the set of ids is the same, not the element behind each.
    expect(instanceIds(after)).toEqual(instanceIds(before));
  });

  it('same-tag sibling inserted before: the group id holds, later positional instance ids move (documented limit)', () => {
    const rig = open(ROWS(3));
    const before = rig.run();
    const fresh = document.createElement('li');
    fresh.className = 'low';
    fresh.textContent = 'inserted';
    $('#rows').prepend(fresh);
    const after = rig.run();
    expect(groupIds(after)).toEqual(groupIds(before));
    expect(findingsOf(after, 'CA-COLOR-001')[0]?.affectedCount).toBe(4);
    const kept = instanceIds(before).filter((id) => instanceIds(after).includes(id));
    expect(kept.length).toBeGreaterThan(0);
  });

  it('an element with a unique id keeps its instance id when same-tag siblings are inserted before it', () => {
    const rig = open('<div id="host"><p id="x" class="low">x</p></div>');
    const before = rig.run();
    $('#host').prepend(document.createElement('p'), document.createElement('p'));
    expect(instanceIds(rig.run())).toEqual(instanceIds(before));
  });

  it('React-style replacement: old node removed, an equivalent one inserted -> same ids, new target locatable', () => {
    const rig = open('<div id="host"><p class="low">x</p></div>');
    const before = rig.run();
    const old = $('#host p');
    const replacement = old.cloneNode(true) as HTMLElement;
    old.replaceWith(replacement);
    const after = rig.run();
    expect(groupIds(after)).toEqual(groupIds(before));
    expect(instanceIds(after)).toEqual(instanceIds(before));
    const finding = findingsOf(after, 'CA-COLOR-001')[0]!;
    const result = rig.audit.highlight({ findingId: finding.id, index: 0, scroll: false });
    expect(result.ok).toBe(true);
    expect(old.isConnected).toBe(false);
    // The highlight describes the live node, never the removed one.
    expect(document.querySelectorAll('[data-coloradapt-audit-overlay]').length).toBe(1);
  });

  it('a removed element: the old finding is gone and highlighting it says so', () => {
    const rig = open(NAMED);
    const finding = findingsOf(rig.run(), 'CA-COLOR-001')[0]!;
    $('#a').remove();
    $('#b').remove();
    $('#c').remove();
    const after = rig.run();
    expect(findingsOf(after, 'CA-COLOR-001')).toEqual([]);
    expect(rig.audit.highlight({ findingId: finding.id, index: 0, scroll: false }).ok).toBe(false);
    expect(document.querySelectorAll('[data-coloradapt-audit-overlay]').length).toBe(0);
  });

  it('reparenting between wrappers: still located, grouped once, the old path is gone', () => {
    const rig = open(
      '<div id="w1"><p id="m" class="low">m</p></div><div id="w2"><p id="n" class="low">n</p></div>',
    );
    const before = rig.run();
    expect(findingsOf(before, 'CA-COLOR-001')).toHaveLength(1);
    $('#w2').append($('#m'));
    const after = rig.run();
    const finding = findingsOf(after, 'CA-COLOR-001')[0]!;
    expect(findingsOf(after, 'CA-COLOR-001')).toHaveLength(1);
    expect(finding.affectedCount).toBe(2);
    expect(finding.affected.map((a) => a.locator.path)).not.toContain('#w1>p');
    expect(rig.audit.highlight({ findingId: finding.id, index: 0, scroll: false }).ok).toBe(true);
    expect(rig.audit.highlight({ findingId: finding.id, index: 1, scroll: false }).ok).toBe(true);
  });
});

describe('grouping does not merge unrelated components', () => {
  const link = (cls = 'link') => `<a href="/x" class="low ${cls}">go</a>`;

  it('two navigation components with different identities are two findings', () => {
    const rig = open(
      `<nav id="primary">${link()}${link()}</nav><nav id="footer-links">${link()}</nav>`,
    );
    const found = findingsOf(rig.run(), 'CA-COLOR-001');
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.affectedCount).sort()).toEqual([1, 2]);
  });

  it('the same component in a header and in a footer is two findings', () => {
    const rig = open(`<header>${link()}</header><footer>${link()}</footer>`);
    expect(findingsOf(rig.run(), 'CA-COLOR-001')).toHaveLength(2);
  });

  it('two forms with different roles/ids are two findings; rows of one table stay one', () => {
    const rig = open(
      `<form id="login"><span class="low hint">a</span></form>` +
        `<form id="signup"><span class="low hint">b</span></form>` +
        `<table id="t"><tbody>${Array.from({ length: 5 }, (_, i) => `<tr id="row-${i + 10}"><td class="low cell">c</td></tr>`).join('')}</tbody></table>`,
    );
    const found = findingsOf(rig.run(), 'CA-COLOR-001');
    expect(found.map((f) => f.affectedCount).sort()).toEqual([1, 1, 5]);
  });

  it('per-row ids never split a repeated component into one finding per row', () => {
    const rig = open(
      `<ul>${Array.from({ length: 30 }, (_, i) => `<li id="item-${i + 100}" class="low">r</li>`).join('')}</ul>`,
    );
    const found = findingsOf(rig.run(), 'CA-COLOR-001');
    expect(found).toHaveLength(1);
    expect(found[0]?.affectedCount).toBe(30);
  });

  it('shared tag, class, color and rule across unrelated landmarks do not merge', () => {
    const rig = open(
      `<main><p class="low note">a</p></main><aside><p class="low note">b</p></aside>` +
        `<section aria-label="One"><p class="low note">c</p></section>`,
    );
    expect(findingsOf(rig.run(), 'CA-COLOR-001')).toHaveLength(3);
  });

  it('copies inside one region merge, and the region scope does not move with insertions around it', () => {
    const rig = open(`<main><p class="low note">a</p><p class="low note">b</p></main>`);
    const before = groupIds(rig.run());
    expect(before).toHaveLength(1);
    document.body.prepend(document.createElement('main'));
    expect(groupIds(rig.run())).toEqual(before);
  });
});
