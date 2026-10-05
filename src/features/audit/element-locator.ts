import {
  LOCATOR_LIMITS,
  componentClassNames,
  redactSnippet,
  safeName,
  type AuditLocator,
  type AuditTargetInput,
} from '@core/audit';

/**
 * Turns an element into what the audit may say about it (docs/DEVELOPER_AUDIT.md, "Element
 * locator", docs/PRIVACY.md "Developer audit"):
 *
 * - an *identity key* that is the element's place in the page's structure (tag and position among
 *   same-tag siblings, anchored at the nearest unique `id`), so the same element is the same on
 *   every run whatever classes, text or state it has right now, and an equivalent node that
 *   replaces it takes its place;
 * - a short readable path for developers (the last few steps of that key);
 * - a bounded snippet of its own visible text, never for anything a user types into.
 *
 * Nothing else about the element is read: no `value`, no `data-*`, no `href`, no `src`.
 */

const INPUT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
  'color',
  'range',
  'checkbox',
  'radio',
  'file',
  'submit',
  'reset',
  'button',
  'image',
  'hidden',
]);

export const INTERACTIVE_SELECTOR =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, ' +
  '[role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], ' +
  '[role="radio"], [role="switch"], [role="option"], [role="combobox"], [role="textbox"], [role="slider"]';

/** Form controls and editable regions: their text and value belong to the user, not to the page. */
export function isSensitiveElement(element: Element): boolean {
  const tag = element.localName;
  if (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    tag === 'option' ||
    tag === 'datalist'
  ) {
    return true;
  }
  const editable = element.closest('[contenteditable]');
  return editable !== null && editable.getAttribute('contenteditable')?.toLowerCase() !== 'false';
}

export function isInteractiveElement(element: Element): boolean {
  return element.closest(INTERACTIVE_SELECTOR) !== null;
}

/** A form field the user fills in (as opposed to a control that is merely clicked). */
export function isFieldElement(element: Element): boolean {
  const tag = element.localName;
  if (tag === 'input')
    return !/^(?:submit|reset|button|image)$/.test(
      element.getAttribute('type')?.toLowerCase() ?? '',
    );
  if (tag === 'textarea' || tag === 'select') return true;
  const role = element.getAttribute('role');
  return role === 'textbox' || role === 'combobox' || role === 'searchbox';
}

/** Up to `limit` characters of the visible text under `element`, without building the whole string. */
export function readTextSnippet(element: Element, limit: number = LOCATOR_LIMITS.textRead): string {
  const doc = element.ownerDocument;
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = (node as Element).localName;
        return tag === 'script' || tag === 'style' || tag === 'template' || tag === 'noscript'
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let text = '';
  for (let node = walker.nextNode(); node && text.length < limit; node = walker.nextNode()) {
    text += `${node.nodeValue ?? ''} `;
  }
  return text.slice(0, limit);
}

const REGION_TAGS: ReadonlySet<string> = new Set([
  'nav',
  'header',
  'footer',
  'main',
  'aside',
  'form',
  'dialog',
  'table',
  'figure',
]);
const REGION_ROLES: ReadonlySet<string> = new Set([
  'navigation',
  'banner',
  'contentinfo',
  'main',
  'complementary',
  'region',
  'form',
  'search',
  'dialog',
  'alertdialog',
  'tablist',
  'grid',
  'table',
  'figure',
  'toolbar',
  'menu',
  'menubar',
]);
/** How many nested regions tell two components apart (`header>nav`). */
const REGION_DEPTH = 3;

/** `tag[role]#id` of an element that is a landmark or a named region, else null. */
function regionStep(element: Element): string | null {
  const tag = element.localName.replace(/[^a-z0-9-]/g, '');
  const role = element.getAttribute('role')?.toLowerCase() ?? '';
  const named = element.hasAttribute('aria-label') || element.hasAttribute('aria-labelledby');
  const isRegion =
    REGION_TAGS.has(tag) ||
    REGION_ROLES.has(role) ||
    ((tag === 'section' || tag === 'article') && named);
  if (!isRegion) return null;
  const safeRole = REGION_ROLES.has(role) ? role : '';
  const [componentId] = componentClassNames([element.id], 1);
  return `${tag}${safeRole ? `[${safeRole}]` : ''}${componentId ? `#${componentId}` : ''}`;
}

/**
 * One locator context per audit pass: the memo tables that keep describing thousands of elements
 * linear (a path is built from its parent's; a sibling index is computed once per parent).
 */
export class LocatorContext {
  readonly #doc: Document;
  readonly #steps = new WeakMap<Element, string>();
  readonly #anchors = new WeakMap<Element, boolean>();
  readonly #indexes = new WeakMap<Element, Map<Element, number>>();
  readonly #scopes = new WeakMap<Element, string>();

  constructor(doc: Document) {
    this.#doc = doc;
  }

  #isAnchor(element: Element): boolean {
    const cached = this.#anchors.get(element);
    if (cached !== undefined) return cached;
    const id = element.id;
    const safe = id !== '' && safeName(id) === id;
    const unique = safe && this.#doc.getElementById(id) === element;
    this.#anchors.set(element, unique);
    return unique;
  }

  /** Position of `element` among its parent's children of the same tag. */
  #siblingInfo(element: Element): { readonly nth: number } {
    const parent = element.parentElement;
    if (!parent) return { nth: 1 };
    let table = this.#indexes.get(parent);
    if (!table) {
      table = new Map();
      const counts = new Map<string, number>();
      for (const child of parent.children) {
        const next = (counts.get(child.localName) ?? 0) + 1;
        counts.set(child.localName, next);
        table.set(child, next);
      }
      this.#indexes.set(parent, table);
    }
    return { nth: table.get(element) ?? 1 };
  }

  /**
   * The landmarks and named regions an element sits in, outermost first (`header>nav`). Two copies
   * of one component in different regions are different findings; copies inside one region (the
   * rows of one table) are one. Only the kind of region and a component-like `id` count (never an
   * ordinal, a per-row id or a class that can toggle with state), so the scope does not move when
   * siblings are added, removed or reordered.
   */
  #scope(element: Element): string {
    const parent = element.parentElement;
    if (!parent) return '';
    const memo = this.#scopes.get(parent);
    if (memo !== undefined) return memo;
    const outer = this.#scope(parent);
    const region = regionStep(parent);
    const chain = region ? (outer ? `${outer}>${region}` : region) : outer;
    const limited = chain.split('>').slice(-REGION_DEPTH).join('>');
    this.#scopes.set(parent, limited);
    return limited;
  }

  /** `#anchor>ul>li:nth-of-type(3)>span`: structure only, anchored at the nearest unique id. */
  #path(element: Element): string {
    const memo = this.#steps.get(element);
    if (memo !== undefined) return memo;
    let path: string;
    if (this.#isAnchor(element)) path = `#${element.id}`;
    else {
      const parent = element.parentElement;
      const tag = element.localName.replace(/[^a-z0-9-]/g, '');
      // Always numbered (except the document's own spine): a sibling added later must not rename this element.
      const { nth } = this.#siblingInfo(element);
      const step = tag === 'html' || tag === 'body' ? tag : `${tag}:nth-of-type(${nth})`;
      path = parent ? `${this.#path(parent)}>${step}` : step;
    }
    this.#steps.set(element, path);
    return path;
  }

  describe(element: Element): AuditTargetInput {
    const tag = element.localName.replace(/[^a-z0-9-]/g, '') || 'element';
    const rawClasses = (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    const classes = rawClasses
      .map((name) => safeName(name))
      .filter((name): name is string => name !== null && name !== '[redacted]')
      .slice(0, LOCATOR_LIMITS.classes);
    const id = safeName(element.id);
    const role = safeName(element.getAttribute('role')?.toLowerCase());
    const rawType = tag === 'input' ? (element.getAttribute('type') ?? 'text').toLowerCase() : null;
    const inputType = rawType === null ? null : INPUT_TYPES.has(rawType) ? rawType : 'other';

    let text: string | null = null;
    if (!isSensitiveElement(element) && tag !== 'svg' && tag !== 'canvas') {
      text =
        tag === 'img'
          ? redactSnippet(element.getAttribute('alt') ?? '')
          : redactSnippet(readTextSnippet(element));
    }

    const identity = this.#path(element);
    const steps = identity.split('>');
    const shown =
      steps.length > LOCATOR_LIMITS.pathSegments
        ? `…>${steps.slice(-LOCATOR_LIMITS.pathSegments).join('>')}`
        : identity;
    const component = [
      tag,
      role ? `[${role}]` : '',
      inputType ? `:${inputType}` : '',
      ...componentClassNames(rawClasses, LOCATOR_LIMITS.classes)
        .sort()
        .map((name) => `.${name}`),
    ].join('');
    const scope = this.#scope(element);
    const locator: AuditLocator = { tag, id, classes, role, inputType, text, path: shown };
    return { key: identity, locator, component: scope ? `${component}@${scope}` : component };
  }
}
