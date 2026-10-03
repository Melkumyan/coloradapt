import { isColorAdaptOwnedMutation, removesColorAdaptStyle } from './ownership';
import { isClassChangeRelevant, isStyleChangeRelevant } from './style-relevance';
import type { ClassifiedMutation } from './types';

/**
 * Attributes the observer subscribes to on arbitrary elements. `class` and
 * `style` are the two ways a page restyles an element; `hidden`/`disabled`/
 * `aria-disabled`/`role` change eligibility; `href`/`media`/`rel` only matter
 * on `<link>` (a swapped stylesheet). Everything else, including every other
 * `data-*`, is not delivered at all.
 */
export const OBSERVED_ATTRIBUTES: readonly string[] = [
  'class',
  'style',
  'hidden',
  'disabled',
  'aria-disabled',
  'role',
  'href',
  'media',
  'rel',
];

/** On `<html>`/`<body>` any theme-switch attribute (`data-theme`, `data-bs-theme`, ...) counts. */
export const THEME_ATTRIBUTE = /theme|color-?mode|color-?scheme|^data-mode$/i;

/** Elements that can never carry adaptable text or restyle the page. */
const INERT_TAGS: ReadonlySet<string> = new Set([
  'script',
  'noscript',
  'template',
  'meta',
  'title',
  'base',
]);

const STYLESHEET_SELECTOR = 'style, link[rel~="stylesheet" i]';

export interface ClassifyContext {
  readonly doc: Document;
}

function isStylesheetLink(element: Element): element is HTMLLinkElement {
  return (
    element.localName === 'link' &&
    /(^|\s)stylesheet(\s|$)/i.test(element.getAttribute('rel') ?? '')
  );
}

function isStylesheetNode(element: Element): boolean {
  return element.localName === 'style' || isStylesheetLink(element);
}

/**
 * A stylesheet node changed. A `<link>` that is in the document and will fetch
 * something (non-empty `href`, not `disabled`) has no effect on the cascade
 * until that fetch ends, so nothing can be decided before its `load`/`error`
 * (`pendingLink`). That is the case when
 *
 * - it has no sheet yet (just inserted, `rel` switched to `stylesheet`, or
 *   re-enabled: Chromium fires `load` again), or
 * - its `href` just changed: the *old* sheet stays in `link.sheet` and keeps
 *   applying until the new one arrives, so an immediate rescan would read it.
 *
 * Everything else is an immediate change: a link that left the document, or
 * was disabled, has no sheet either, but that is the *removal* of its rules,
 * not a load to wait for (waiting would leave them stale forever).
 */
function stylesheetChange(element: Element, hrefChanged = false): ClassifiedMutation {
  if (
    isStylesheetLink(element) &&
    element.isConnected &&
    !element.hasAttribute('disabled') &&
    (element.getAttribute('href') ?? '') !== '' &&
    (!element.sheet || hrefChanged)
  ) {
    return { kind: 'STYLESHEET_CHANGE', pendingLink: element };
  }
  return { kind: 'STYLESHEET_CHANGE' };
}

function isDocumentRoot(element: Element, doc: Document): boolean {
  return element === doc.documentElement || element === doc.body;
}

function classifyElementNode(element: Element, added: boolean): ClassifiedMutation[] {
  if (INERT_TAGS.has(element.localName)) return [{ kind: 'IRRELEVANT', reason: 'inert-tag' }];
  if (isStylesheetNode(element)) return [stylesheetChange(element)];
  const nodeChange: ClassifiedMutation = { kind: added ? 'NODE_ADDED' : 'NODE_REMOVED', element };
  if (!element.firstElementChild) return [nodeChange];

  // Every stylesheet in the subtree counts (each pending link needs its own wait).
  const sheets = [...element.querySelectorAll(STYLESHEET_SELECTOR)].map((nested) =>
    stylesheetChange(nested),
  );
  if (sheets.length === 0) return [nodeChange];
  // A rescan covers the whole subtree; if every stylesheet is still loading, the
  // rest of the content must not wait for them, so it gets its own region now.
  return sheets.every((sheet) => sheet.kind === 'STYLESHEET_CHANGE' && sheet.pendingLink)
    ? [...sheets, nodeChange]
    : sheets;
}

/** Text added to / removed from `parent` can change whether it has own text. */
function classifyTextParent(parent: Node): ClassifiedMutation {
  if (parent.nodeType !== Node.ELEMENT_NODE) {
    return { kind: 'IRRELEVANT', reason: 'non-element-parent' };
  }
  const element = parent as Element;
  if (element.localName === 'style') return { kind: 'STYLESHEET_CHANGE' };
  if (INERT_TAGS.has(element.localName)) return { kind: 'IRRELEVANT', reason: 'inert-tag' };
  return { kind: 'TEXT_CHANGE', element };
}

function classifyAttribute(record: MutationRecord, context: ClassifyContext): ClassifiedMutation {
  const target = record.target as Element;
  const name = record.attributeName ?? '';
  const current = target.getAttribute(name);
  const previous = record.oldValue;

  if (target.localName === 'link' || target.localName === 'style') {
    // `disabled`, `media`, `href`, `rel` on a stylesheet change the whole cascade.
    if (isStylesheetNode(target) || name === 'rel') {
      return previous === current
        ? { kind: 'IRRELEVANT', reason: 'no-net-change' }
        : stylesheetChange(target, name === 'href');
    }
    return { kind: 'IRRELEVANT', reason: 'non-stylesheet-link' };
  }
  if (INERT_TAGS.has(target.localName)) return { kind: 'IRRELEVANT', reason: 'inert-tag' };

  if (isDocumentRoot(target, context.doc) && THEME_ATTRIBUTE.test(name)) {
    return previous === current
      ? { kind: 'IRRELEVANT', reason: 'no-net-change' }
      : { kind: 'STYLE_AFFECTING_ATTRIBUTE', element: target, attribute: name };
  }

  switch (name) {
    case 'class':
      return isClassChangeRelevant(previous, current)
        ? { kind: 'STYLE_AFFECTING_ATTRIBUTE', element: target, attribute: name }
        : { kind: 'IRRELEVANT', reason: 'class-unchanged' };
    case 'style':
      return isStyleChangeRelevant(previous, current, context.doc)
        ? { kind: 'STYLE_AFFECTING_ATTRIBUTE', element: target, attribute: name }
        : { kind: 'IRRELEVANT', reason: 'style-not-color-related' };
    case 'hidden':
    case 'disabled':
    case 'aria-disabled':
    case 'role':
      return previous === current
        ? { kind: 'IRRELEVANT', reason: 'no-net-change' }
        : { kind: 'STYLE_AFFECTING_ATTRIBUTE', element: target, attribute: name };
    default:
      return { kind: 'IRRELEVANT', reason: 'unobserved-attribute' };
  }
}

function classifyCharacterData(record: MutationRecord): ClassifiedMutation {
  const target = record.target as CharacterData;
  const parent = target.parentNode;
  if (!parent) return { kind: 'IRRELEVANT', reason: 'detached-text' };
  const element = parent.nodeType === Node.ELEMENT_NODE ? (parent as Element) : null;
  if (element?.localName === 'style') return { kind: 'STYLESHEET_CHANGE' };
  if (!element || INERT_TAGS.has(element.localName) || target.nodeType !== Node.TEXT_NODE) {
    return { kind: 'IRRELEVANT', reason: 'not-element-text' };
  }
  // Only a switch between "no text" and "some text" can change eligibility.
  const hadText = (record.oldValue ?? '').trim().length > 0;
  const hasText = target.data.trim().length > 0;
  return hadText === hasText
    ? { kind: 'IRRELEVANT', reason: 'text-eligibility-unchanged' }
    : { kind: 'TEXT_CHANGE', element };
}

export interface BatchClassification {
  readonly mutations: readonly ClassifiedMutation[];
  /** Per-kind counts, including the ones that carry no work. */
  readonly counts: Readonly<Record<ClassifiedMutation['kind'], number>>;
}

/**
 * Classifies one batch of records. Each mutation becomes one or more
 * {@link ClassifiedMutation}s; the decision is explicit and DOM-state based
 * (docs/DYNAMIC_ANALYSIS.md, "Mutation types"). Repeated attribute or text
 * changes to the same target within the batch are judged once, on the net
 * change from the value before the batch to the current one, so
 * `class A, B, C, A` is no change at all.
 */
export function classifyMutations(
  records: readonly MutationRecord[],
  context: ClassifyContext,
): BatchClassification {
  const mutations: ClassifiedMutation[] = [];
  const counts: Record<ClassifiedMutation['kind'], number> = {
    NODE_ADDED: 0,
    NODE_REMOVED: 0,
    STYLE_AFFECTING_ATTRIBUTE: 0,
    TEXT_CHANGE: 0,
    STYLESHEET_CHANGE: 0,
    IRRELEVANT: 0,
    COLORADAPT_INTERNAL: 0,
  };
  const push = (mutation: ClassifiedMutation) => {
    counts[mutation.kind] += 1;
    mutations.push(mutation);
  };

  const judgedAttributes = new Map<Node, Set<string>>();
  const judgedText = new Set<Node>();

  for (const record of records) {
    if (isColorAdaptOwnedMutation(record)) {
      push({ kind: 'COLORADAPT_INTERNAL', stylesheetRemoved: removesColorAdaptStyle(record) });
      continue;
    }

    if (record.type === 'attributes') {
      const name = record.attributeName ?? '';
      const seen = judgedAttributes.get(record.target) ?? new Set<string>();
      judgedAttributes.set(record.target, seen);
      if (seen.has(name)) {
        push({ kind: 'IRRELEVANT', reason: 'coalesced' });
        continue;
      }
      seen.add(name);
      push(classifyAttribute(record, context));
      continue;
    }

    if (record.type === 'characterData') {
      if (judgedText.has(record.target)) {
        push({ kind: 'IRRELEVANT', reason: 'coalesced' });
        continue;
      }
      judgedText.add(record.target);
      push(classifyCharacterData(record));
      continue;
    }

    let textTouched = false;
    let anyNode = false;
    for (const [nodes, added] of [
      [record.addedNodes, true],
      [record.removedNodes, false],
    ] as const) {
      for (const node of nodes) {
        anyNode = true;
        if (node.nodeType === Node.ELEMENT_NODE) {
          for (const mutation of classifyElementNode(node as Element, added)) push(mutation);
        } else if (node.nodeType === Node.TEXT_NODE && !textTouched) {
          textTouched = true;
          push(classifyTextParent(record.target));
        }
      }
    }
    if (!anyNode) push({ kind: 'IRRELEVANT', reason: 'empty-record' });
  }

  return { mutations, counts };
}
