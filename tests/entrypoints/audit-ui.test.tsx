import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUDIT_SEVERITIES,
  NO_FILTERS,
  SEVERITY_GLYPH,
  SEVERITY_LABEL,
  buildSnapshot,
  type AuditFilters,
  type AuditFinding,
} from '@core/audit';
import {
  FilterPanel,
  FindingCard,
  SeverityBadge,
  SummaryBar,
} from '../../src/entrypoints/audit/components';
import { FACTORS, candidate, target } from '../core/audit/builders';

/**
 * The audit page must follow the rule it audits (docs/DEVELOPER_AUDIT.md, "The audit UI"):
 * semantic buttons and labels, expand/collapse state in `aria-expanded`, a visible focus ring, and
 * severity as a word and a shape, never as a hue. jsdom renders the real components; the real
 * browser page is exercised in e2e/audit.spec.ts.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(element: ReturnType<typeof createElement>): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(element));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const snapshot = buildSnapshot({
  candidates: [
    candidate({ target: target('html>body>p:nth-of-type(1)', 'p', { text: 'Pale text' }) }),
    candidate({
      ruleId: 'CA-SEM-001',
      context: 'invalid',
      target: target('#a', 'input'),
      factors: {
        ...FACTORS,
        informationLoss: 'total',
        functionalImpact: 'major',
        interactive: true,
      },
    }),
    candidate({
      ruleId: 'CA-CHART-004',
      assessment: 'manual-review',
      context: 'canvas',
      target: target('html>body>canvas', 'canvas'),
    }),
    ...Array.from({ length: 7 }, (_, i) =>
      candidate({
        ruleId: 'CA-SEM-001',
        context: 'offline',
        target: target(`html>body>ul>li:nth-of-type(${i + 1})`, 'li.dot'),
      }),
    ),
  ],
  generation: 1,
  timestamp: 0,
  page: { origin: 'https://example.test', pathname: '/' },
  extensionVersion: '0.1.0',
  settings: {
    activeProfile: 'deuteranopia',
    auditedProfiles: ['deuteranopia'],
    adaptationEnabled: false,
  },
  coverage: {
    elementsAnalyzed: 1,
    analysisTruncated: false,
    semanticCandidates: 0,
    svgUnits: 0,
    charts: 0,
    canvases: 0,
    images: 0,
  },
}).snapshot;

const group = snapshot.findings.find((f) => f.affectedCount === 7) as AuditFinding;

describe('severity badge', () => {
  it('shows a word and a distinct shape for every level', () => {
    const host = render(
      createElement(
        'div',
        null,
        ...AUDIT_SEVERITIES.map((severity) =>
          createElement(SeverityBadge, { key: severity, severity }),
        ),
      ),
    );
    const badges = [...host.querySelectorAll('.badge')];
    expect(badges).toHaveLength(5);
    expect(new Set(SEVERITY_GLYPH_VALUES()).size).toBe(5);
    badges.forEach((badge, i) => {
      const severity = AUDIT_SEVERITIES[i]!;
      expect(badge.textContent).toContain(SEVERITY_LABEL[severity]);
      expect(badge.textContent).toContain(SEVERITY_GLYPH[severity]);
      expect(badge.querySelector('[aria-hidden="true"]')?.textContent).toBe(
        SEVERITY_GLYPH[severity],
      );
    });
  });

  it('is not told apart by color in the stylesheet either: no severity rule sets a color', () => {
    const css = readFileSync(
      path.resolve(import.meta.dirname, '../../src/entrypoints/audit/App.css'),
      'utf8',
    );
    for (const match of css.matchAll(/\.badge--(\w+)\s*\{([^}]*)\}/g)) {
      expect(match[2], match[1]).not.toMatch(
        /(?:^|[;\s])(?:color|background(?:-color)?|border-color|outline-color)\s*:/,
      );
    }
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline/);
  });
});

function SEVERITY_GLYPH_VALUES(): string[] {
  return AUDIT_SEVERITIES.map((s) => SEVERITY_GLYPH[s]);
}

describe('finding card', () => {
  const mount = (
    expanded: boolean,
    onHighlight = () => undefined,
    highlighted: number | null = null,
  ) => {
    let open = expanded;
    const view = () =>
      createElement(FindingCard, {
        finding: group,
        expanded: open,
        highlighted,
        onToggle: () => {
          open = !open;
          act(() => root!.render(view()));
        },
        onHighlight,
      });
    return render(view());
  };

  it('is a heading with a real button that carries expand/collapse state and names its panel', () => {
    const host = mount(false);
    const button = host.querySelector('h3 > button') as HTMLButtonElement;
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const panel = document.getElementById(button.getAttribute('aria-controls')!)!;
    expect(panel.hasAttribute('hidden')).toBe(true);
    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hasAttribute('hidden')).toBe(false);
    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('says severity, kind, count, confidence, adaptation and profile in words on the collapsed card', () => {
    const text = mount(false).textContent ?? '';
    expect(text).toContain(SEVERITY_LABEL[group.severity]);
    expect(text).toContain('7 elements');
    expect(text).toContain('High confidence');
    expect(text).toContain('Issue');
    expect(text).toContain('ColorAdapt: Adaptation off');
    expect(text).toContain('Not profile-specific');
    expect(text).toContain('CA-SEM-001');
  });

  it('expands to evidence with column headers, a recommendation, the model confidence and the affected elements', () => {
    const host = mount(true);
    const table = host.querySelector('table.evidence') as HTMLTableElement;
    expect([...table.querySelectorAll('th[scope="col"]')].map((th) => th.textContent)).toEqual([
      'Evidence',
      'Value',
      'Basis',
    ]);
    expect(host.textContent).toContain('Recommendation');
    expect(host.textContent).toContain('Finding confidence');
    expect(host.textContent).toContain('Affected elements (7)');
    expect(host.textContent).toContain('not a conformance statement');
    expect(host.querySelectorAll('ol.card__targets > li')).toHaveLength(7);
    expect(host.querySelector('details > summary')?.textContent).toBe('Technical details');
  });

  it('highlights through plain buttons: one per element, plus previous and next that wrap around', () => {
    const calls: Array<[number, boolean]> = [];
    const host = mount(
      true,
      ((index: number, scroll: boolean) => calls.push([index, scroll])) as never,
      6,
    );
    const buttons = [...host.querySelectorAll('button')];
    const named = (label: string) => buttons.find((b) => b.textContent === label)!;
    act(() => named('Next element').click());
    act(() => named('Previous element').click());
    act(() => buttons.filter((b) => b.textContent === 'Show on page')[2]!.click());
    expect(calls).toEqual([
      [0, true], // after the last element comes the first
      [5, true],
      [2, true],
    ]);
    expect(host.querySelector('[data-testid="element-position"]')?.textContent).toBe(
      'Element 7 of 7',
    );
    expect(host.querySelector('li[aria-current="true"]')).not.toBeNull();
  });

  it('every button is a button, every control has a name', () => {
    const host = mount(true);
    for (const button of host.querySelectorAll('button'))
      expect(button.textContent?.trim().length).toBeGreaterThan(0);
  });
});

describe('filters', () => {
  const mountFilters = (filters: AuditFilters = NO_FILTERS) => {
    const seen: AuditFilters[] = [];
    const host = render(
      createElement(FilterPanel, {
        findings: snapshot.findings,
        filters,
        onChange: (next: AuditFilters) => seen.push(next),
        onClear: () => seen.push(NO_FILTERS),
        filtering: filters !== NO_FILTERS,
      }),
    );
    return { host, seen };
  };

  it('are labeled checkboxes grouped in fieldsets with legends, and a labeled search box', () => {
    const { host } = mountFilters();
    expect([...host.querySelectorAll('fieldset > legend')].map((l) => l.textContent)).toEqual([
      'Severity',
      'Category',
      'Confidence',
      'ColorAdapt',
      'Vision profile',
      'Kind',
    ]);
    const search = host.querySelector('input[type="search"]') as HTMLInputElement;
    expect(host.querySelector(`label[for="${search.id}"]`)?.textContent).toMatch(/Search/);
    for (const box of host.querySelectorAll('input[type="checkbox"]')) {
      expect(box.closest('label')?.textContent?.trim().length).toBeGreaterThan(0);
    }
  });

  it('show how many findings each option would keep, and disable the ones that keep none', () => {
    const { host } = mountFilters();
    const labels = [...host.querySelectorAll('label.filters__option')];
    const critical = labels.find((l) => l.textContent?.includes('Critical'))!;
    expect(critical.textContent).toContain('(1)');
    const info = labels.find((l) => l.textContent?.includes('Low'))!;
    expect((info.querySelector('input') as HTMLInputElement).disabled).toBe(true);
  });

  it('report a change in terms of the filter model', () => {
    const { host, seen } = mountFilters();
    const box = [...host.querySelectorAll('label.filters__option')]
      .find((l) => l.textContent?.includes('Critical'))!
      .querySelector('input') as HTMLInputElement;
    act(() => box.click());
    expect(seen[0]?.severity).toEqual(['critical']);
  });

  it('can be cleared only when something is set', () => {
    expect((mountFilters().host.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    const { host } = mountFilters({ ...NO_FILTERS, severity: ['high'] });
    expect((host.querySelector('button') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('summary', () => {
  it('shows counts per severity as a list with words, and no score', () => {
    const host = render(createElement(SummaryBar, { summary: snapshot.summary }));
    const items = [...host.querySelectorAll('ul[aria-label="Findings by severity"] > li')];
    expect(items).toHaveLength(5);
    expect(host.textContent).not.toMatch(/\d+\s*\/\s*100/);
    expect(host.textContent).toMatch(/no basis for a single accessibility score/);
    const total = items.reduce(
      (sum, li) => sum + Number(li.querySelector('[data-testid^="count-"]')?.textContent),
      0,
    );
    expect(total).toBe(snapshot.summary.findings);
  });
});
