import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ASSIST_COVERAGE,
  ASSIST_COVERAGE_LABEL,
  ASSIST_STATUS_LABEL,
  type AuditSemanticAssistEntry,
} from '@core/audit';
import {
  AssistBadge,
  AssistBlock,
  AssistPanel,
} from '../../src/entrypoints/audit/assist-components';
import type { SemanticAssistState } from '../../src/entrypoints/audit/use-semantic-assist';

/**
 * The AI panel follows the rule the audit enforces (docs/DEVELOPER_AUDIT.md, "The audit UI"): every state
 * is a word and a distinct symbol, never a color; the run control is a real button with a name; progress
 * and completion are announced in a status region; nothing takes focus by itself; and with the setting
 * off the panel says so instead of looking like a clean review.
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

const state = (over: Partial<SemanticAssistState> = {}): SemanticAssistState => ({
  enabled: true,
  running: false,
  coverage: 'not-run',
  provider: { provider: 'local-ollama', model: 'qwen2.5:7b-instruct' },
  stats: null,
  failure: null,
  heterogeneous: 0,
  entries: new Map(),
  run: () => Promise.resolve(),
  report: () => {
    throw new Error('not used');
  },
  diagnostics: () => null,
  ...over,
});

const entry = (over: Partial<AuditSemanticAssistEntry> = {}): AuditSemanticAssistEntry => ({
  findingId: 'CA-SVG-002:0123456789abcdef',
  task: 'CLASSIFY_CONTROL_ICON',
  modelStatus: 'SUPPORTED_HYPOTHESIS',
  validatorStatus: 'ACCEPTED_ADVISORY',
  validatorReason: 'accepted',
  hypothesis: 'close',
  modelConfidence: 0.9,
  evidenceRefs: ['e1'],
  supportingEvidence: [{ id: 'e1', source: 'accessible-name', value: 'Close' }],
  inputFingerprint: '0123456789abcdef',
  instances: 1,
  sampled: 1,
  ...over,
});

const STATS = {
  eligible: 4,
  queried: 3,
  deduped: 0,
  cacheHits: 0,
  accepted: 1,
  rejected: 1,
  unresolved: 1,
  modelErrors: 0,
  timeouts: 0,
  notQueued: 1,
};

describe('AI panel: every coverage state has a word and a symbol', () => {
  for (const coverage of ASSIST_COVERAGE) {
    it(`${coverage}: ${ASSIST_COVERAGE_LABEL[coverage]}`, () => {
      const element = render(
        createElement(AssistPanel, {
          assist: state({
            coverage: coverage,
            enabled: coverage !== 'disabled',
            stats: coverage === 'completed' || coverage === 'partial' ? STATS : null,
          }),
        }),
      );
      const line = element.querySelector('[data-testid="assist-coverage"]');
      expect(line?.getAttribute('data-coverage')).toBe(coverage);
      expect(line?.textContent).toContain(ASSIST_COVERAGE_LABEL[coverage]);
      // A shape and words, never color alone.
      expect(ASSIST_COVERAGE_LABEL[coverage]).toMatch(/^[●◐○✕] \S/u);
    });
  }

  it('says that the setting is off, offers no run, and never reads as a finished review', () => {
    const element = render(
      createElement(AssistPanel, { assist: state({ enabled: false, coverage: 'disabled' }) }),
    );
    expect(element.querySelector('[data-testid="assist-run"]')).toBeNull();
    expect(element.textContent).toMatch(/off by default/i);
    expect(element.textContent).not.toMatch(/reviewed/i);
  });

  it('has a run button with a name that is disabled while running and takes no focus by itself', () => {
    const element = render(
      createElement(AssistPanel, { assist: state({ running: true, coverage: 'not-run' }) }),
    );
    const button = element.querySelector<HTMLButtonElement>('[data-testid="assist-run"]');
    expect(button?.tagName).toBe('BUTTON');
    expect(button?.textContent?.trim().length).toBeGreaterThan(5);
    expect(button?.disabled).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });

  it('announces counts in a status region and an unavailable runtime as an alert', () => {
    const done = render(
      createElement(AssistPanel, { assist: state({ coverage: 'partial', stats: STATS }) }),
    );
    const status = done.querySelector('[role="status"]');
    expect(status?.textContent).toContain('1 not queued');
    expect(status?.textContent).toContain('1 likely meaning');
    act(() => root?.unmount());
    host?.remove();
    const down = render(
      createElement(AssistPanel, {
        assist: state({ coverage: 'unavailable', failure: 'http-error', stats: STATS }),
      }),
    );
    expect(down.querySelector('[role="alert"]')?.textContent).toContain('unavailable');
    expect(down.querySelector('[role="alert"]')?.textContent).toContain('OLLAMA_ORIGINS');
    // Only a status code: no body of a response is ever shown.
    expect(down.textContent).not.toMatch(/<[a-z]+/i);
  });

  it('explains findings left alone because their elements differ, in words', () => {
    const element = render(
      createElement(AssistPanel, {
        assist: state({ coverage: 'partial', stats: STATS, heterogeneous: 2 }),
      }),
    );
    const text = element.querySelector('[data-testid="assist-heterogeneous"]')?.textContent ?? '';
    expect(text).toContain('2 findings not sent to the model');
    expect(text).toContain('manual review');
  });
});

describe('AI result: every status is words plus a symbol, and never a confirmation', () => {
  for (const status of ['ACCEPTED_ADVISORY', 'REJECTED', 'UNRESOLVED'] as const) {
    it(`${status}: ${ASSIST_STATUS_LABEL[status]}`, () => {
      const e = entry({
        validatorStatus: status,
        validatorReason: status === 'ACCEPTED_ADVISORY' ? 'accepted' : 'insufficient-corroboration',
        hypothesis: status === 'ACCEPTED_ADVISORY' ? 'close' : null,
      });
      const badge = render(createElement(AssistBadge, { entry: e }));
      const text = badge.textContent ?? '';
      expect(text).toMatch(/^[●✕○] AI-assisted interpretation:/u);
      expect(
        badge.querySelector('[data-testid="assist-badge"]')?.getAttribute('data-assist-status'),
      ).toBe(status);
      expect(text).toMatch(
        status === 'ACCEPTED_ADVISORY' ? /Likely meaning: close/ : /Needs review/,
      );
      act(() => root?.unmount());
      host?.remove();
      const block = render(
        createElement(AssistBlock, {
          entry: e,
          provider: { provider: 'local-ollama', model: 'm' },
        }),
      );
      expect(block.textContent).toContain('Not a confirmed deterministic finding');
      expect(block.textContent).toMatch(/AI semantic assist/);
      expect(block.textContent).not.toMatch(/\bconfirmed (by|violation)|proved|WCAG (fail|pass)/i);
      expect(block.querySelector('h4')?.textContent).toBe('AI-assisted interpretation');
    });
  }

  it('says whose interpretation a group of several elements carries', () => {
    const block = render(
      createElement(AssistBlock, {
        entry: entry({ instances: 7, sampled: 4 }),
        provider: { provider: 'local-http', model: null },
      }),
    );
    const scope = block.querySelector('[data-testid="assist-scope"]')?.textContent ?? '';
    expect(scope).toContain('Representative element');
    expect(scope).toContain('4 of 7');
  });

  it('renders hostile provider and model text as text', () => {
    const block = render(
      createElement(AssistBlock, {
        entry: entry({
          supportingEvidence: [
            { id: 'e1', source: '<b>x</b>', value: '<img src=x onerror=alert(1)>' },
          ],
        }),
        provider: { provider: 'local-http', model: '<script>alert(1)</script>' },
      }),
    );
    expect(block.querySelector('script, img')).toBeNull();
    expect(block.textContent).toContain('<script>alert(1)</script>');
  });
});
