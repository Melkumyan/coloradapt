import { redactSnippet, safeName } from '@core/audit';
import { SOURCE_KIND, stateWordsIn } from '@core/semantics';
import type { SemanticFacts } from './facts';
import type { EvidenceStrength, SemanticEvidenceKind } from './query';
import type { SemanticTask } from './taxonomy';

/**
 * Turning facts into deterministic evidence. Every `supports` / `contradicts` below is ColorAdapt's
 * own judgement, written down here and nowhere else: the model never says what a fact means.
 */

export interface RawEvidence {
  readonly kind: SemanticEvidenceKind;
  readonly source: string;
  readonly value: string;
  readonly strength: EvidenceStrength;
  readonly supports: readonly string[];
  readonly contradicts: readonly string[];
}

/** ARIA attributes read, and the token values allowed to reach a packet. */
export const SEMANTIC_ARIA_ATTRIBUTES = [
  'aria-selected',
  'aria-current',
  'aria-disabled',
  'aria-checked',
  'aria-pressed',
  'aria-invalid',
  'aria-required',
  'aria-live',
  'aria-expanded',
] as const;
const ARIA_VALUE =
  /^(?:true|false|mixed|page|step|location|date|time|polite|assertive|off|grammar|spelling)$/;

/** An M6 state (or family) as the labels of a state task. */
const STATE_LABELS: Readonly<Record<SemanticTask, Readonly<Record<string, readonly string[]>>>> = {
  CLASSIFY_UI_STATE: {
    selected: ['selected'],
    unselected: ['unselected'],
    active: ['active'],
    inactive: ['inactive'],
    enabled: ['available'],
    online: ['available'],
    disabled: ['unavailable'],
    offline: ['unavailable'],
    error: ['error'],
    invalid: ['error'],
    warning: ['warning'],
    success: ['success'],
    valid: ['success'],
    info: ['informational'],
    alert: ['error', 'warning'],
    status: ['success', 'informational'],
  },
  CLASSIFY_STATUS_MEANING: {
    error: ['error'],
    invalid: ['error'],
    warning: ['warning'],
    success: ['success'],
    valid: ['success'],
    info: ['informational'],
    positive: ['positive'],
    negative: ['negative'],
    increase: ['increase'],
    decrease: ['decrease'],
    online: ['online'],
    offline: ['offline'],
    alert: ['error', 'warning'],
    status: ['success', 'informational'],
  },
  ASSESS_COLOR_DEPENDENCE: {},
  MAP_CHART_LABEL: {},
  CLASSIFY_CONTROL_ICON: {},
  ASSESS_MANUAL_REVIEW_CASE: {},
};

export function labelsOfState(task: SemanticTask, state: string): readonly string[] {
  return STATE_LABELS[task][state] ?? [];
}

/** The task whose label space holds an M6 state: controls' own states, otherwise statuses. */
const CONTROL_STATES: ReadonlySet<string> = new Set([
  'selected',
  'unselected',
  'active',
  'inactive',
  'enabled',
  'disabled',
]);

export function taskForState(state: string): SemanticTask {
  return CONTROL_STATES.has(state) ? 'CLASSIFY_UI_STATE' : 'CLASSIFY_STATUS_MEANING';
}

const STATE_TASKS: ReadonlySet<SemanticTask> = new Set([
  'CLASSIFY_UI_STATE',
  'CLASSIFY_STATUS_MEANING',
]);

/** Roles whose items are selected / current / available in turn. */
const CONTROL_FAMILY_ROLES: ReadonlySet<string> = new Set([
  'tab',
  'option',
  'menuitem',
  'menuitemradio',
  'menuitemcheckbox',
  'treeitem',
  'radio',
  'switch',
  'checkbox',
  'gridcell',
  'row',
]);
const CONTROL_FAMILY = ['selected', 'unselected', 'active', 'inactive'];

/** Whole words, lower case: what an icon's name, title, class segment or nearby text may say. */
export const ICON_VOCABULARY: Readonly<Record<string, readonly string[]>> = {
  close: ['close', 'dismiss', 'cancel', 'закрыть', 'закрытие', 'отмена'],
  menu: ['menu', 'hamburger', 'меню'],
  search: ['search', 'find', 'magnifier', 'поиск', 'найти'],
  settings: ['settings', 'gear', 'cog', 'preferences', 'настройки', 'настройка'],
  delete: ['delete', 'remove', 'trash', 'bin', 'удалить', 'корзина'],
  add: ['add', 'plus', 'create', 'добавить', 'создать'],
  edit: ['edit', 'pencil', 'modify', 'редактировать', 'изменить'],
  download: ['download', 'скачать'],
  upload: ['upload', 'загрузить'],
  share: ['share', 'поделиться'],
  favorite: ['favorite', 'favourite', 'bookmark', 'star', 'like', 'избранное', 'нравится'],
  back: ['back', 'previous', 'prev', 'назад'],
  forward: ['forward', 'next', 'вперёд', 'вперед', 'далее'],
  expand: ['expand', 'развернуть'],
  collapse: ['collapse', 'свернуть'],
  help: ['help', 'question', 'справка', 'помощь'],
  notification: ['notification', 'notifications', 'bell', 'уведомления', 'уведомление'],
  user: ['user', 'account', 'profile', 'пользователь', 'профиль', 'аккаунт'],
  home: ['home', 'главная', 'домой'],
  refresh: ['refresh', 'reload', 'sync', 'обновить'],
};

function words(text: string): string[] {
  return text
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Icon labels a piece of text names (whole words only: `closet` does not say `close`). */
export function iconLabelsIn(text: string): string[] {
  const found = new Set<string>(words(text));
  const out: string[] = [];
  for (const [label, vocabulary] of Object.entries(ICON_VOCABULARY)) {
    if (vocabulary.some((word) => found.has(word))) out.push(label);
  }
  return out;
}

const norm = (text: string): string => words(text).join(' ');

/** A state label is a few words. A sentence, markup, a quotation or a code fragment is not one. */
const MAX_STATE_TEXT_WORDS = 4;
const NOT_A_LABEL = /[{}[\]<>"`$\\]|https?:|\/\//;
function looksLikeStateText(text: string): boolean {
  return words(text).length <= MAX_STATE_TEXT_WORDS && !NOT_A_LABEL.test(text);
}

const TEXTUAL_SOURCES = ['text-token', 'aria-label', 'title-token', 'aria-describedby'];

function signalValue(source: string, value: string): string {
  if (TEXTUAL_SOURCES.includes(source)) return redactSnippet(value, 24) ?? '[redacted]';
  const raw = value.toLowerCase().replace(/\s+/g, '-');
  if (source === 'data-token') {
    const [name, ...rest] = raw.split('=');
    return `${safeName(name) ?? '?'}=${safeName(rest.join('=')) ?? '[redacted]'}`;
  }
  return safeName(raw) ?? '[redacted]';
}

function ariaEvidence(facts: SemanticFacts, out: RawEvidence[]): void {
  const ui = facts.task === 'CLASSIFY_UI_STATE';
  for (const name of SEMANTIC_ARIA_ATTRIBUTES) {
    const value = facts.aria[name];
    if (value === undefined || !ARIA_VALUE.test(value)) continue;
    const base = { kind: 'aria' as const, source: name, value: `${name}=${value}` };
    if (name === 'aria-selected' && ui) {
      if (value === 'true')
        out.push({
          ...base,
          strength: 'strong',
          supports: ['selected'],
          contradicts: ['unselected'],
        });
      if (value === 'false')
        out.push({
          ...base,
          strength: 'strong',
          supports: ['unselected'],
          contradicts: ['selected'],
        });
    } else if ((name === 'aria-checked' || name === 'aria-pressed') && ui) {
      if (value === 'true')
        out.push({
          ...base,
          strength: 'medium',
          supports: ['selected'],
          contradicts: ['unselected'],
        });
      if (value === 'false')
        out.push({
          ...base,
          strength: 'medium',
          supports: ['unselected'],
          contradicts: ['selected'],
        });
    } else if (name === 'aria-current' && ui) {
      if (value === 'false')
        out.push({ ...base, strength: 'weak', supports: ['inactive'], contradicts: [] });
      else
        out.push({ ...base, strength: 'medium', supports: ['active'], contradicts: ['inactive'] });
    } else if (name === 'aria-disabled' && ui) {
      if (value === 'true')
        out.push({
          ...base,
          strength: 'strong',
          supports: ['unavailable'],
          contradicts: ['available'],
        });
      if (value === 'false')
        out.push({
          ...base,
          strength: 'medium',
          supports: ['available'],
          contradicts: ['unavailable'],
        });
    } else if (name === 'aria-invalid') {
      if (value === 'false')
        out.push({ ...base, strength: 'strong', supports: [], contradicts: ['error'] });
      else out.push({ ...base, strength: 'strong', supports: ['error'], contradicts: [] });
    } else if (name === 'aria-live' && value === 'assertive') {
      out.push({ ...base, strength: 'weak', supports: ['error', 'warning'], contradicts: [] });
    }
  }
}

function stateEvidence(facts: SemanticFacts, out: RawEvidence[]): void {
  const task = facts.task;
  for (const signal of facts.signals) {
    // ARIA is read from `aria` (with its false values); an aria-label is read below, from the sanitized name.
    if (signal.source.startsWith('aria-')) continue;
    // The text of a form field is its value: nothing it says is page text a packet may carry.
    if (facts.isField && TEXTUAL_SOURCES.includes(signal.source)) continue;
    const kind = (SOURCE_KIND as Readonly<Record<string, SemanticEvidenceKind | undefined>>)[
      signal.source
    ];
    if (!kind) continue;
    out.push({
      kind,
      source: signal.source,
      value: signalValue(signal.source, signal.value),
      strength: signal.strength,
      supports: kind === 'color' ? [] : labelsOfState(task, signal.supports),
      contradicts: [],
    });
  }
  if (task === 'CLASSIFY_UI_STATE') {
    if (facts.role && CONTROL_FAMILY_ROLES.has(facts.role)) {
      out.push({
        kind: 'structure',
        source: 'control-role',
        value: `role=${safeName(facts.role) ?? '?'}`,
        strength: 'weak',
        supports: CONTROL_FAMILY,
        contradicts: [],
      });
    }
    const alike = facts.peers.filter((peer) => peer.tag === facts.tag && peer.role === facts.role);
    if (alike.length >= 2 && facts.colorRelation === 'color-only-difference') {
      out.push({
        kind: 'structure',
        source: 'peer-structure',
        value: `${Math.min(alike.length, 99)} peers of the same kind differ by color only`,
        strength: 'weak',
        supports: CONTROL_FAMILY,
        contradicts: [],
      });
    }
  }
  // Words of the accessible name and of the neighbouring labels name a state in the page's own language.
  const named: [string, string | null, EvidenceStrength, SemanticEvidenceKind][] = [
    ['accessible-name', facts.isField ? null : facts.accessibleName, 'medium', 'label'],
  ];
  facts.nearbyLabels
    .slice(0, 3)
    .forEach((text) => named.push(['nearby-label', text, 'weak', 'context']));
  for (const [source, text, strength, kind] of named) {
    if (!text) continue;
    const clean = redactSnippet(text, 60);
    if (!clean || !looksLikeStateText(clean)) continue;
    for (const state of stateWordsIn(clean)) {
      const labels = labelsOfState(task, state);
      if (labels.length > 0)
        out.push({ kind, source, value: clean, strength, supports: labels, contradicts: [] });
    }
  }
}

function decorativeEvidence(
  facts: SemanticFacts,
  out: RawEvidence[],
  decorative: string,
  carries: string | null,
): void {
  if (facts.interactive) return;
  const against = carries === null ? [] : [carries];
  // What the author *declared* presentational is firm; merely hiding a subtree from assistive technology
  // says nothing about whether it carries information (a hidden chart is a problem, not decoration).
  if (facts.presentational) {
    out.push({
      kind: 'aria',
      source: 'presentational',
      value: 'declared presentational (role or empty alt)',
      strength: 'strong',
      supports: [decorative],
      contradicts: against,
    });
  } else if (facts.hiddenFromAT) {
    out.push({
      kind: 'aria',
      source: 'hidden-from-at',
      value: 'hidden from assistive technology',
      strength: 'medium',
      supports: [decorative],
      contradicts: [],
    });
  }
}

function iconEvidence(facts: SemanticFacts, out: RawEvidence[]): void {
  decorativeEvidence(facts, out, 'decorative', null);
  const name = facts.isField ? null : facts.accessibleName;
  const cleanName = name ? redactSnippet(name, 60) : null;
  // A name that is one word of an icon's vocabulary ("Close") is firm; a longer phrase ("User Guide",
  // "Edit this at Wikidata") only contains the word and is a clue.
  const nameStrength: EvidenceStrength =
    cleanName && words(cleanName).length === 1 ? 'strong' : 'medium';
  const sources: [string, string | null, EvidenceStrength, SemanticEvidenceKind][] = [
    ['accessible-name', cleanName, nameStrength, 'label'],
    ['title', facts.isField ? null : facts.title, 'medium', 'label'],
    ['class-segments', facts.classSegments.join(' '), 'medium', 'class'],
  ];
  facts.nearbyLabels
    .slice(0, 2)
    .forEach((text) => sources.push(['nearby-label', text, 'weak', 'context']));
  for (const [source, text, strength, kind] of sources) {
    if (!text) continue;
    const clean = redactSnippet(text, 60);
    if (!clean) continue;
    for (const label of iconLabelsIn(clean)) {
      out.push({ kind, source, value: clean, strength, supports: [label], contradicts: [] });
    }
  }
}

function informationEvidence(
  facts: SemanticFacts,
  out: RawEvidence[],
  carries: string,
  decorative: string,
): void {
  decorativeEvidence(facts, out, decorative, carries);
  const name = facts.isField ? null : (facts.accessibleName ?? facts.title);
  const clean = name ? redactSnippet(name, 60) : null;
  if (clean) {
    out.push({
      kind: 'label',
      source: 'accessible-name',
      value: clean,
      strength: 'medium',
      supports: [carries],
      contradicts: [],
    });
  }
  const near = facts.nearbyLabels[0] ? redactSnippet(facts.nearbyLabels[0], 60) : null;
  if (near) {
    out.push({
      kind: 'context',
      source: 'nearby-label',
      value: near,
      strength: 'weak',
      supports: [carries],
      contradicts: [],
    });
  }
  if (facts.interactive) {
    out.push({
      kind: 'structure',
      source: 'interactive',
      value: 'the element is operated by the user',
      strength: 'weak',
      supports: [carries],
      contradicts: [decorative],
    });
  }
}

function chartEvidence(facts: SemanticFacts, out: RawEvidence[]): void {
  const chart = facts.chart;
  if (!chart) return;
  const entry = chart.legendEntry ? norm(chart.legendEntry) : '';
  if (entry !== '') {
    const named = chart.series
      .map((series, index) => ({ index, title: series.title ? norm(series.title) : '' }))
      .filter((item) => item.title === entry);
    const only = named[0];
    if (named.length === 1 && only) {
      out.push({
        kind: 'label',
        source: 'legend-title',
        value: redactSnippet(chart.legendEntry ?? '', 40) ?? '',
        strength: 'strong',
        supports: [`series-${only.index + 1}`],
        contradicts: [],
      });
    }
  }
  if (chart.swatchColorName) {
    const same = chart.series
      .map((series, index) => ({ index, color: series.colorName }))
      .filter((item) => item.color === chart.swatchColorName);
    if (same.length > 0) {
      out.push({
        kind: 'swatch',
        source: 'legend-swatch',
        value: `swatch ${safeName(chart.swatchColorName) ?? '?'} matches ${same.length} series`,
        strength: same.length === 1 ? 'strong' : 'medium',
        supports: same.map((item) => `series-${item.index + 1}`),
        contradicts: [],
      });
    }
  }
  if (
    chart.legendIndex !== null &&
    chart.legendCount === chart.series.length &&
    chart.legendIndex >= 1 &&
    chart.legendIndex <= chart.series.length
  ) {
    out.push({
      kind: 'order',
      source: 'legend-order',
      value: `entry ${chart.legendIndex} of ${chart.legendCount}`,
      strength: 'weak',
      supports: [`series-${chart.legendIndex}`],
      contradicts: [],
    });
  }
}

/** All evidence a task can draw from the facts, before ids and budgets. */
export function deriveEvidence(facts: SemanticFacts): RawEvidence[] {
  const out: RawEvidence[] = [];
  if (STATE_TASKS.has(facts.task)) {
    ariaEvidence(facts, out);
    stateEvidence(facts, out);
  } else if (facts.task === 'CLASSIFY_CONTROL_ICON') iconEvidence(facts, out);
  else if (facts.task === 'ASSESS_COLOR_DEPENDENCE')
    informationEvidence(facts, out, 'color-carries-meaning', 'color-decorative');
  else if (facts.task === 'ASSESS_MANUAL_REVIEW_CASE')
    informationEvidence(facts, out, 'carries-information', 'decorative');
  else chartEvidence(facts, out);
  return out;
}
