import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_CATEGORIES,
  AUDIT_MILESTONES,
  AUDIT_RULES,
  AUDIT_RULE_IDS,
  AUDIT_SUBCATEGORIES,
  buildRecommendation,
  getRule,
} from '@core/audit';

const DOCS = path.resolve(import.meta.dirname, '../../../docs');
const read = (name: string) => readFileSync(path.join(DOCS, name), 'utf8');

describe('rule registry', () => {
  it('keeps the published rule ids (ids are stable: never renamed, never reused)', () => {
    expect([...AUDIT_RULE_IDS].sort()).toEqual([
      'CA-CHART-001',
      'CA-CHART-002',
      'CA-CHART-003',
      'CA-CHART-004',
      'CA-COLOR-001',
      'CA-COLOR-002',
      'CA-COLOR-003',
      'CA-GEN-001',
      'CA-IMG-001',
      'CA-IMG-002',
      'CA-IMG-003',
      'CA-SEM-001',
      'CA-SEM-002',
      'CA-SVG-001',
      'CA-SVG-002',
    ]);
  });

  it('is keyed by each rule’s own id, in the CA-<AREA>-<NNN> form', () => {
    for (const [key, rule] of Object.entries(AUDIT_RULES)) {
      expect(rule.id).toBe(key);
      expect(key).toMatch(/^CA-[A-Z]+-\d{3}$/);
    }
  });

  it('gives every rule a category, a subcategory, a source and a recommendation', () => {
    for (const rule of Object.values(AUDIT_RULES)) {
      expect(AUDIT_CATEGORIES).toContain(rule.category);
      expect(AUDIT_SUBCATEGORIES).toContain(rule.subcategory);
      expect(AUDIT_MILESTONES).toContain(rule.source.primary);
      for (const m of rule.source.contributing) expect(AUDIT_MILESTONES).toContain(m);
      expect(rule.title.length).toBeGreaterThan(5);
      expect(rule.description.length).toBeGreaterThan(20);
      expect(rule.recommendation.summary).not.toMatch(/improve accessibility\.?$/i);
      expect(rule.recommendation.actions.length).toBeGreaterThan(0);
    }
  });

  it('covers every category the milestone names (dynamic-content is reserved, see docs)', () => {
    const used = new Set(Object.values(AUDIT_RULES).map((r) => r.category));
    for (const category of AUDIT_CATEGORIES) {
      if (category === 'dynamic-content') continue;
      expect(used.has(category)).toBe(true);
    }
  });

  it('relates to WCAG criteria, never claims conformance or failure', () => {
    for (const rule of Object.values(AUDIT_RULES)) {
      for (const relation of rule.wcag) expect(relation.relation).toBe('related-to');
      const text = [
        rule.title,
        rule.description,
        rule.summary,
        rule.recommendation.summary,
        ...rule.recommendation.actions,
      ].join(' ');
      expect(text).not.toMatch(
        /\b(?:violat|non-?complian|fails? (?:wcag|aa|aaa)|conformance failure)/i,
      );
    }
  });

  it('marks simulation-based rules and only those as depending on a model', () => {
    for (const id of ['CA-COLOR-002', 'CA-SVG-001', 'CA-CHART-001', 'CA-IMG-001']) {
      expect(getRule(id)?.simulationBased).toBe(true);
    }
    for (const id of ['CA-COLOR-001', 'CA-SEM-001', 'CA-CHART-004']) {
      expect(getRule(id)?.simulationBased).toBe(false);
    }
  });

  it('answers null for a rule that does not exist', () => {
    expect(getRule('CA-NOPE-001')).toBeNull();
  });
});

describe('rule documentation', () => {
  const rules = read('AUDIT_RULES.md');

  it('documents every rule id under its own heading', () => {
    for (const id of AUDIT_RULE_IDS) {
      expect(rules, id).toMatch(new RegExp(`^## ${id} — `, 'm'));
    }
  });

  it('documents no rule that the registry does not have', () => {
    const documented = [...rules.matchAll(/^## (CA-[A-Z]+-\d{3}) — /gm)].map((m) => m[1]);
    for (const id of documented) expect(AUDIT_RULE_IDS).toContain(id);
  });

  it('ships the other audit documents', () => {
    expect(read('DEVELOPER_AUDIT.md').length).toBeGreaterThan(2000);
    expect(read('AUDIT_EXPORT_SCHEMA.md')).toContain('schemaVersion');
  });
});

describe('recommendations', () => {
  it('are templates: the same input gives the same text', () => {
    const a = buildRecommendation('CA-SEM-001', { state: 'invalid', adaptation: 'adapted' });
    const b = buildRecommendation('CA-SEM-001', { state: 'invalid', adaptation: 'adapted' });
    expect(b).toEqual(a);
  });

  it('say what ColorAdapt did, and that the source page still needs the fix', () => {
    const adapted = buildRecommendation('CA-COLOR-001', { adaptation: 'adapted' });
    expect(adapted.coloradapt).toMatch(/source page is unchanged/i);
    expect(
      buildRecommendation('CA-COLOR-001', { adaptation: 'no-safe-candidate' }).coloradapt,
    ).toMatch(/could not safely correct this automatically/i);
  });

  it('offer a color only from a validated suggestion, labeled as ColorAdapt’s', () => {
    expect(
      buildRecommendation('CA-COLOR-001', { adaptation: 'not-enabled' }).suggestedColor,
    ).toBeNull();
    const suggested = buildRecommendation('CA-COLOR-001', {
      adaptation: 'adapted',
      suggestedHex: '#767676',
    });
    expect(suggested.suggestedColor).toMatchObject({
      hex: '#767676',
      origin: 'coloradapt-generated',
    });
    expect(suggested.suggestedColor?.note).toMatch(/not a standard/i);
    expect(
      buildRecommendation('CA-COLOR-001', { adaptation: 'adapted', suggestedHex: 'red' })
        .suggestedColor,
    ).toBeNull();
  });

  it('do not invent a state-specific glyph', () => {
    const rec = buildRecommendation('CA-SEM-001', { state: 'invalid', adaptation: 'not-enabled' });
    expect(rec.actions.join(' ')).not.toMatch(/✓|✗|⚠|checkmark|exclamation/i);
    expect(rec.actions[0]).toMatch(/invalid state/);
  });

  it('fall back to a neutral text for an unknown rule', () => {
    expect(buildRecommendation('CA-NOPE-001', { adaptation: 'not-enabled' }).summary).toMatch(
      /manually/,
    );
  });
});
