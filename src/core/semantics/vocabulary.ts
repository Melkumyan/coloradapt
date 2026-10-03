import type { SemanticState } from './types';

/**
 * The only language-dependent part of the semantic engine, kept in one place
 * (docs/SEMANTIC_ACCESSIBILITY.md, "Text and token policy"). Everything else is
 * language-neutral: ARIA, native state, roles, exact identifier tokens.
 *
 * Nothing here is looked up over the network and nothing is translated.
 */

// ---------------------------------------------------------------------------
// Identifier tokens (class names, ids, data-* values)
// ---------------------------------------------------------------------------

/**
 * Splits an identifier into lower-case segments: `has-error`, `is_invalid`, `badgeSuccess`
 * and `status:online` all yield their words. Matching is on whole segments, so `terror`,
 * `successor` and `errorless` never match `error` / `success`.
 */
export function identifierSegments(value: string): string[] {
  return value
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(Boolean);
}

/** Whitespace-separated tokens of a class list / id list, lower-cased, order kept. */
export function listTokens(value: string | null | undefined): string[] {
  return (value ?? '').split(/\s+/).filter(Boolean);
}

/** Segments that name a state when they appear in a class / data attribute. */
export const STATE_SEGMENTS: Readonly<Record<string, SemanticState>> = {
  error: 'error',
  danger: 'error',
  failed: 'error',
  failure: 'error',
  invalid: 'invalid',
  success: 'success',
  successful: 'success',
  valid: 'valid',
  warning: 'warning',
  warn: 'warning',
  caution: 'warning',
  info: 'info',
  information: 'info',
  selected: 'selected',
  active: 'active',
  inactive: 'inactive',
  disabled: 'disabled',
  required: 'required',
  positive: 'positive',
  negative: 'negative',
  online: 'online',
  offline: 'offline',
  increase: 'increase',
  increased: 'increase',
  decrease: 'decrease',
  decreased: 'decrease',
};

/**
 * Segments in front of which a state word names a *variant* of a control, not a state of it:
 * `btn-danger` is a red button, not a failed one.
 */
export const VARIANT_PREFIXES: ReadonlySet<string> = new Set(['btn', 'button']);

/**
 * Words that may follow a state word in an identifier without changing what it says:
 * `alert-danger-subtle`, `error-message`, `active-tab`, `selected-row`. Anything else after the
 * state word makes it a topic, not a state (`error-prone`, `success-stories`, `online-users`,
 * `inactiveUser`, `warning-yellow`): such a token is not evidence. A state word at the *end* of an
 * identifier (`badge-success`, `is-active`, `hasError`) needs no such check.
 */
export const STATE_SUFFIX_WORDS: ReadonlySet<string> = new Set([
  // what is marked
  'tab',
  'item',
  'link',
  'row',
  'cell',
  'page',
  'step',
  'option',
  'button',
  'btn',
  'nav',
  'menu',
  'segment',
  'node',
  'field',
  'input',
  'control',
  'box',
  // what kind of component carries it
  'state',
  'status',
  'message',
  'msg',
  'text',
  'label',
  'banner',
  'alert',
  'icon',
  'badge',
  'border',
  'bg',
  'background',
  'color',
  'feedback',
  'notice',
  'toast',
  'dot',
  'indicator',
  'pill',
  'tag',
  'chip',
  'bar',
  'mark',
  'marker',
  'flag',
  'sign',
  'glyph',
  // style modifiers
  'subtle',
  'soft',
  'light',
  'dark',
  'solid',
  'outline',
  'filled',
  'sm',
  'lg',
  'xs',
  'xl',
  'small',
  'large',
  'mini',
  'tiny',
  'inline',
  'block',
  'bold',
]);

/** `data-*` attributes whose value is read as a state token. */
export const STATE_DATA_ATTRIBUTES: readonly string[] = [
  'data-state',
  'data-status',
  'data-variant',
  'data-type',
  'data-severity',
  'data-kind',
  'data-validity',
  'data-selected',
  'data-active',
  'data-invalid',
];

/** Boolean-style data attributes: `data-selected="true"` supports `selected`. */
export const BOOLEAN_DATA_STATES: Readonly<Record<string, SemanticState>> = {
  'data-selected': 'selected',
  'data-active': 'active',
  'data-invalid': 'invalid',
};

// ---------------------------------------------------------------------------
// Component context: tokens that say what *kind* of component an element is.
// They never classify; they corroborate a state of the matching family.
// ---------------------------------------------------------------------------

export type StateFamily = 'status' | 'presence' | 'highlight' | 'polarity';

/** A state can belong to several families (`active` is a presence and a highlight). */
export const STATE_FAMILIES: Readonly<Partial<Record<SemanticState, readonly StateFamily[]>>> = {
  success: ['status'],
  error: ['status'],
  warning: ['status'],
  info: ['status'],
  valid: ['status'],
  invalid: ['status'],
  online: ['presence'],
  offline: ['presence'],
  active: ['presence', 'highlight'],
  inactive: ['presence', 'highlight'],
  selected: ['highlight'],
  unselected: ['highlight'],
  positive: ['polarity'],
  negative: ['polarity'],
  increase: ['polarity'],
  decrease: ['polarity'],
};

/** Context segments per family. */
export const CONTEXT_SEGMENTS: Readonly<Record<StateFamily, ReadonlySet<string>>> = {
  status: new Set([
    'alert',
    'message',
    'notice',
    'notification',
    'toast',
    'banner',
    'callout',
    'feedback',
    'badge',
    'pill',
    'chip',
    'tag',
    'status',
    'indicator',
    'flash',
    'snackbar',
  ]),
  presence: new Set(['status', 'presence', 'indicator', 'dot', 'availability', 'badge']),
  highlight: new Set(['tab', 'nav', 'menu', 'item', 'option', 'step', 'link', 'segment']),
  polarity: new Set(['delta', 'change', 'trend', 'diff', 'gain', 'variance']),
};

// ---------------------------------------------------------------------------
// Visible-text vocabulary, per locale
// ---------------------------------------------------------------------------

export type Locale = 'en' | 'ru';

/** Whole words (lower-case) that name a state in visible text, accessible names and titles. */
export const TEXT_VOCABULARY: Readonly<Record<Locale, Readonly<Record<string, SemanticState>>>> = {
  en: {
    error: 'error',
    errors: 'error',
    failed: 'error',
    failure: 'error',
    invalid: 'invalid',
    success: 'success',
    successful: 'success',
    successfully: 'success',
    warning: 'warning',
    caution: 'warning',
    info: 'info',
    information: 'info',
    required: 'required',
    online: 'online',
    offline: 'offline',
  },
  ru: {
    ошибка: 'error',
    ошибки: 'error',
    ошибок: 'error',
    ошибочно: 'error',
    сбой: 'error',
    неудача: 'error',
    неудачно: 'error',
    недопустимо: 'invalid',
    недопустимый: 'invalid',
    неверно: 'invalid',
    неверный: 'invalid',
    недействительно: 'invalid',
    успешно: 'success',
    успех: 'success',
    успешный: 'success',
    предупреждение: 'warning',
    внимание: 'warning',
    осторожно: 'warning',
    информация: 'info',
    инфо: 'info',
    обязательно: 'required',
    обязательное: 'required',
    обязательный: 'required',
    онлайн: 'online',
    офлайн: 'offline',
    оффлайн: 'offline',
  },
};

/** A negator next to a state word flips or cancels its meaning ("no errors", "без ошибок"). */
export const NEGATORS: ReadonlySet<string> = new Set([
  'no',
  'not',
  'without',
  'never',
  'un',
  'нет',
  'не',
  'без',
  'ни',
]);

/** Text longer than this (in words) is prose, not a status label. */
export const MAX_STATE_TEXT_WORDS = 6;

/** Text is cut here before it is looked at (also the bound on what facts carry). */
export const MAX_TEXT_LENGTH = 160;

export function textWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * The states a short text names. Empty when the text is prose (too many words), contains a
 * negator, or has no vocabulary word. Several distinct states mean the text contradicts itself;
 * the caller sees both.
 */
export function stateWordsIn(text: string, truncated = false): SemanticState[] {
  if (truncated) return [];
  const words = textWords(text);
  if (words.length === 0 || words.length > MAX_STATE_TEXT_WORDS) return [];
  if (words.some((word) => NEGATORS.has(word))) return [];
  const found = new Set<SemanticState>();
  for (const word of words) {
    for (const locale of Object.keys(TEXT_VOCABULARY) as Locale[]) {
      const state = TEXT_VOCABULARY[locale][word];
      if (state) found.add(state);
    }
  }
  return [...found];
}

/** Cheap pre-check used by the mutation classifier: could this text name a state at all? */
export function textMayNameState(text: string): boolean {
  return stateWordsIn(text).length > 0;
}

// ---------------------------------------------------------------------------
// Symbols that already express a state (existing non-color cues)
// ---------------------------------------------------------------------------

/** Characters that are themselves a non-color state cue when they appear in an element's text. */
export const STATE_SYMBOLS = /[✓✔✗✘✕✖×⚠⚡❗❌✅ℹ❓‼!?↑↓⬆⬇▲▼△▽+−*✱●○◉◯]/u;

/** Required-field markers inside a label. */
export const REQUIRED_MARKERS = /[*✱]|\b(?:required|mandatory)\b|(?:обязательн)/iu;
