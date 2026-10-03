import type {
  ElementFacts,
  EvidenceKind,
  EvidenceSource,
  EvidenceStrength,
  EvidenceTarget,
  SemanticEvidence,
  SemanticState,
} from './types';
import {
  BOOLEAN_DATA_STATES,
  CONTEXT_SEGMENTS as CONTEXT_FAMILY_SEGMENTS,
  STATE_DATA_ATTRIBUTES,
  STATE_FAMILIES,
  STATE_SEGMENTS,
  STATE_SUFFIX_WORDS,
  VARIANT_PREFIXES,
  identifierSegments,
  stateWordsIn,
} from './vocabulary';

/** Structural bound: an element never carries more evidence than this. */
export const MAX_EVIDENCE_PER_ELEMENT = 24;

/** Roles for which ARIA defines each state. Outside them the attribute is not read. */
const SELECTED_ROLES: ReadonlySet<string> = new Set([
  'tab',
  'option',
  'row',
  'gridcell',
  'treeitem',
  'columnheader',
  'rowheader',
]);
const CHECKED_ROLES: ReadonlySet<string> = new Set([
  'checkbox',
  'radio',
  'switch',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'treeitem',
]);
const PRESSED_ROLES: ReadonlySet<string> = new Set(['button']);

/** Segments that turn the next word around: `non-active`, `not-valid`, `no-error`. */
const NEGATING_SEGMENTS: ReadonlySet<string> = new Set(['no', 'not', 'non', 'un', 'without']);

export const SOURCE_KIND: Readonly<Record<EvidenceSource, EvidenceKind>> = {
  'aria-invalid': 'aria',
  'aria-selected': 'aria',
  'aria-current': 'aria',
  'aria-disabled': 'aria',
  'aria-checked': 'aria',
  'aria-pressed': 'aria',
  'aria-required': 'aria',
  'aria-live': 'role',
  'aria-label': 'label',
  'aria-describedby': 'label',
  role: 'role',
  'native-invalid': 'native',
  'native-required': 'native',
  'native-disabled': 'native',
  'native-selected': 'native',
  'class-token': 'class',
  'data-token': 'data',
  'text-token': 'text',
  'title-token': 'label',
  'id-token': 'id',
  'context-token': 'context',
  color: 'color',
};

/** The states a visible color is *weak* supporting context for. Never classifies by itself. */
const COLOR_HINT_STATE: Readonly<Record<string, SemanticState>> = {
  red: 'error',
  green: 'success',
  yellow: 'warning',
  blue: 'info',
};

function evidence(
  source: EvidenceSource,
  value: string,
  supports: EvidenceTarget,
  strength: EvidenceStrength,
): SemanticEvidence {
  return { source, value, supports, strength };
}

function isTruthyAria(value: string | undefined): boolean {
  return value !== undefined && value.trim().toLowerCase() === 'true';
}

/**
 * Evidence from an identifier list (class names, ids): one item per token that contains a
 * state word as a whole segment. `btn-danger` (a control variant), `no-error` (negated) and
 * `terror` (not a segment) yield nothing.
 */
export function tokenStates(token: string): SemanticState[] {
  const segments = identifierSegments(token);
  if (segments.length === 0) return [];
  if (VARIANT_PREFIXES.has(segments[0]!)) return [];
  if (segments.some((segment) => NEGATING_SEGMENTS.has(segment))) return [];
  const found = new Set<SemanticState>();
  segments.forEach((segment, index) => {
    const state = STATE_SEGMENTS[segment];
    if (!state) return;
    // `error-prone`, `success-stories`, `inactiveUser`: the state word is the topic, not a state.
    if (!segments.slice(index + 1).every((rest) => STATE_SUFFIX_WORDS.has(rest))) return;
    found.add(state);
  });
  return [...found];
}

/** Class tokens naming a status-family state on an interactive host are control variants. */
function isControlVariant(facts: ElementFacts, state: SemanticState): boolean {
  return (
    facts.isInteractive &&
    STATE_FAMILIES[state]?.includes('status') === true &&
    facts.role !== 'tab'
  );
}

/**
 * Collects every deterministic piece of evidence about one element, with provenance.
 * Order is stable (ARIA, native, role, tokens, text, color), so results are reproducible.
 * Color is recorded as weak evidence and is the only thing here that is not language- or
 * structure-based; `resolveSemantics` never lets it classify.
 */
export function collectEvidence(facts: ElementFacts): SemanticEvidence[] {
  const items: SemanticEvidence[] = [];
  const { aria, role } = facts;
  const effectiveRole = role ?? '';

  // --- ARIA ---------------------------------------------------------------
  const invalid = aria['aria-invalid']?.trim().toLowerCase();
  if (invalid === 'true' || invalid === 'grammar' || invalid === 'spelling') {
    items.push(evidence('aria-invalid', invalid, 'invalid', 'strong'));
  }

  const selected = aria['aria-selected']?.trim().toLowerCase();
  if (SELECTED_ROLES.has(effectiveRole) && (selected === 'true' || selected === 'false')) {
    items.push(
      evidence(
        'aria-selected',
        selected,
        selected === 'true' ? 'selected' : 'unselected',
        'strong',
      ),
    );
  }

  const current = aria['aria-current']?.trim().toLowerCase();
  if (current !== undefined && current !== '' && current !== 'false') {
    items.push(evidence('aria-current', current, 'active', 'strong'));
  }

  const checked = aria['aria-checked']?.trim().toLowerCase();
  if (CHECKED_ROLES.has(effectiveRole) && (checked === 'true' || checked === 'false')) {
    items.push(
      evidence('aria-checked', checked, checked === 'true' ? 'selected' : 'unselected', 'strong'),
    );
  }

  const pressed = aria['aria-pressed']?.trim().toLowerCase();
  if (PRESSED_ROLES.has(effectiveRole) && (pressed === 'true' || pressed === 'false')) {
    items.push(
      evidence('aria-pressed', pressed, pressed === 'true' ? 'active' : 'inactive', 'strong'),
    );
  }

  if (isTruthyAria(aria['aria-disabled'])) {
    items.push(evidence('aria-disabled', 'true', 'disabled', 'strong'));
  }
  if (isTruthyAria(aria['aria-required'])) {
    items.push(evidence('aria-required', 'true', 'required', 'strong'));
  }

  // --- Native form state ----------------------------------------------------
  const { native } = facts;
  if (native.required) items.push(evidence('native-required', 'required', 'required', 'strong'));
  if (native.disabled) items.push(evidence('native-disabled', 'disabled', 'disabled', 'strong'));
  if (native.invalid && native.nonPristine) {
    items.push(evidence('native-invalid', 'validity.valid=false', 'invalid', 'strong'));
  }
  if (native.selectedOption)
    items.push(evidence('native-selected', 'option', 'selected', 'strong'));

  // --- Roles and live regions -------------------------------------------------
  if (effectiveRole === 'alert') items.push(evidence('role', 'alert', 'alert', 'strong'));
  if (effectiveRole === 'status') items.push(evidence('role', 'status', 'status', 'medium'));
  const live = aria['aria-live']?.trim().toLowerCase();
  if (live === 'assertive') items.push(evidence('aria-live', live, 'alert', 'medium'));
  if (live === 'polite') items.push(evidence('aria-live', live, 'status', 'medium'));

  // --- Identifier tokens ------------------------------------------------------
  for (const token of facts.classTokens) {
    for (const state of tokenStates(token)) {
      if (isControlVariant(facts, state)) continue;
      items.push(evidence('class-token', token, state, 'medium'));
    }
  }
  for (const { name, value } of facts.dataValues) {
    const boolean = BOOLEAN_DATA_STATES[name];
    if (boolean) {
      if (value.trim().toLowerCase() === 'true' || value === '') {
        items.push(evidence('data-token', `${name}=${value}`, boolean, 'medium'));
      }
      continue;
    }
    if (!STATE_DATA_ATTRIBUTES.includes(name)) continue;
    for (const state of tokenStates(value)) {
      if (isControlVariant(facts, state)) continue;
      items.push(evidence('data-token', `${name}=${value}`, state, 'medium'));
    }
  }
  for (const token of facts.idTokens) {
    for (const state of tokenStates(token)) items.push(evidence('id-token', token, state, 'weak'));
  }

  // --- Words: visible text, accessible name, title, description ---------------
  for (const state of stateWordsIn(facts.text, facts.textTruncated)) {
    items.push(evidence('text-token', facts.text, state, 'medium'));
  }
  for (const state of stateWordsIn(facts.labelText)) {
    items.push(evidence('aria-label', facts.labelText, state, 'medium'));
  }
  for (const state of stateWordsIn(facts.title)) {
    items.push(evidence('title-token', facts.title, state, 'medium'));
  }
  for (const state of stateWordsIn(facts.describedByText)) {
    items.push(evidence('aria-describedby', facts.describedByText, state, 'medium'));
  }

  // --- Color: weak, supporting context only -----------------------------------
  const hinted = facts.colorHint ? COLOR_HINT_STATE[facts.colorHint] : undefined;
  if (hinted) items.push(evidence('color', facts.colorHint ?? '', hinted, 'weak'));

  return items.slice(0, MAX_EVIDENCE_PER_ELEMENT);
}

/**
 * Adds component-context corroboration: when an element already has medium evidence for a
 * state and its own or its parent's class names say what *kind* of component it is
 * (`badge`, `alert`, `status`, `tab`, ...), that context is a second, independent kind of
 * evidence for the same state. Context alone never classifies anything.
 */
export function addContextEvidence(
  facts: ElementFacts,
  items: readonly SemanticEvidence[],
): SemanticEvidence[] {
  const result = [...items];
  const contextSegments = new Set<string>();
  for (const token of [...facts.classTokens, ...facts.parentClassTokens]) {
    for (const segment of identifierSegments(token)) contextSegments.add(segment);
  }
  const seen = new Set<SemanticState>();
  for (const item of items) {
    if (item.strength !== 'medium' || item.supports === 'alert' || item.supports === 'status') {
      continue;
    }
    if (SOURCE_KIND[item.source] === 'role' || item.source === 'context-token') continue;
    const state = item.supports;
    if (seen.has(state)) continue;
    seen.add(state);
    const families = STATE_FAMILIES[state];
    if (!families) continue;
    const matched = [...contextSegments].find(
      (segment) =>
        !STATE_SEGMENTS[segment] &&
        families.some((family) => CONTEXT_FAMILY_SEGMENTS[family].has(segment)),
    );
    if (matched) result.push(evidence('context-token', matched, state, 'medium'));
  }
  return result.slice(0, MAX_EVIDENCE_PER_ELEMENT);
}
