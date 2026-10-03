import { parseColor } from '@core/color';
import {
  MAX_TEXT_LENGTH,
  STATE_DATA_ATTRIBUTES,
  listTokens,
  type ElementFacts,
  type ElementKind,
  type NativeFacts,
  type StyleSnapshot,
} from '@core/semantics';

/** ARIA attributes the engine reads (docs/SEMANTIC_ACCESSIBILITY.md, "ARIA support"). */
export const ARIA_ATTRIBUTES: readonly string[] = [
  'aria-invalid',
  'aria-selected',
  'aria-current',
  'aria-disabled',
  'aria-checked',
  'aria-pressed',
  'aria-expanded',
  'aria-required',
  'aria-live',
];

const CONTROL_TAGS: ReadonlySet<string> = new Set([
  'input',
  'select',
  'textarea',
  'option',
  'optgroup',
  'img',
  'video',
  'audio',
  'canvas',
  'iframe',
  'object',
  'embed',
  'progress',
  'meter',
  'br',
  'hr',
  'svg',
]);

const FORM_FIELDS: ReadonlySet<string> = new Set(['input', 'select', 'textarea']);

/** Elements that never carry a page-visible state of their own. */
const INERT_TAGS: ReadonlySet<string> = new Set([
  'html',
  'head',
  'body',
  'script',
  'style',
  'link',
  'meta',
  'title',
  'template',
  'noscript',
]);

const IMPLICIT_ROLE: Readonly<Record<string, string>> = {
  button: 'button',
  a: 'link',
  option: 'option',
  tr: 'row',
  td: 'cell',
  th: 'columnheader',
  textarea: 'textbox',
  select: 'combobox',
  li: 'listitem',
};

/** Computed properties that are not paint: if two elements differ in one, color is not their only difference. */
export const SHAPE_PROPERTIES: readonly string[] = [
  'display',
  'width',
  'height',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'font-weight',
  'font-style',
  'font-size',
  'text-decoration-line',
  'text-decoration-style',
  'text-transform',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-left-radius',
  'border-bottom-right-radius',
  'outline-style',
  'outline-width',
  'box-shadow',
  'opacity',
  'transform',
  'background-image',
  'list-style-type',
];

/** Computed properties that are paint only. */
export const PAINT_PROPERTIES: readonly string[] = [
  'color',
  'background-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'text-decoration-color',
  'fill',
  'stroke',
];

export interface FactsEnvironment {
  readonly view: Window;
  /** `content` of `::before` / `::after`, or `none`. Injectable because jsdom has no pseudo-element styles. */
  readonly pseudoContent: (element: Element, pseudo: '::before' | '::after') => string;
  /**
   * Whether the pseudo-element is laid out as a box: its computed `display`, `width` and `height`.
   * Absent where the engine has no pseudo-element layout (jsdom): the check is then skipped.
   */
  readonly pseudoBox?: (
    element: Element,
    pseudo: '::before' | '::after',
  ) => { readonly display: string; readonly width: number; readonly height: number } | null;
}

export function defaultFactsEnvironment(doc: Document): FactsEnvironment {
  const view = doc.defaultView ?? window;
  // jsdom cannot compute pseudo-element styles (and says so on the console for every call).
  const canReadPseudo = !/jsdom/i.test(view.navigator?.userAgent ?? '');
  return {
    view,
    pseudoContent(element, pseudo) {
      if (!canReadPseudo) return 'none';
      try {
        return view.getComputedStyle(element, pseudo).content || 'none';
      } catch {
        return 'none';
      }
    },
    pseudoBox: canReadPseudo
      ? (element, pseudo) => {
          try {
            const style = view.getComputedStyle(element, pseudo);
            return {
              display: style.display,
              width: Number.parseFloat(style.width) || 0,
              height: Number.parseFloat(style.height) || 0,
            };
          } catch {
            return null;
          }
        }
      : () => null,
  };
}

export function effectiveRole(element: Element): string | null {
  const explicit = element.getAttribute('role')?.trim().toLowerCase().split(/\s+/)[0];
  if (explicit) return explicit;
  const tag = element.localName;
  if (tag === 'input') {
    const type = (element.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
    return 'textbox';
  }
  return IMPLICIT_ROLE[tag] ?? null;
}

/** True for hosts whose class names usually name a *variant* of a control (`btn-danger`), not a state. */
function isInteractive(element: Element, role: string | null): boolean {
  if (role === 'button' || role === 'link') return true;
  return element.localName === 'summary';
}

/** Visible text of `element`, whitespace-collapsed, read without walking more than the bound. */
export function visibleText(element: Element): { text: string; truncated: boolean } {
  const doc = element.ownerDocument;
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      for (
        let parent = node.parentElement;
        parent && parent !== element;
        parent = parent.parentElement
      ) {
        if (INERT_TAGS.has(parent.localName) || parent.getAttribute('aria-hidden') === 'true') {
          return NodeFilter.FILTER_REJECT;
        }
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    text += `${node.nodeValue ?? ''} `;
    if (text.length > MAX_TEXT_LENGTH * 2) break;
  }
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_TEXT_LENGTH
    ? { text: collapsed.slice(0, MAX_TEXT_LENGTH), truncated: true }
    : { text: collapsed, truncated: false };
}

function describedByText(element: Element): string {
  const ids = listTokens(element.getAttribute('aria-describedby'));
  if (ids.length === 0) return '';
  const doc = element.ownerDocument;
  const parts: string[] = [];
  for (const id of ids.slice(0, 4)) {
    const target = doc.getElementById(id);
    if (target) parts.push(visibleText(target).text);
  }
  return parts.join(' ').trim();
}

const userInvalidSupport = new WeakMap<object, boolean>();

/** Whether the engine implements `:user-invalid` (Chromium 119+, Firefox 88+; jsdom does not). */
function supportsUserInvalid(view: Window): boolean {
  let supported = userInvalidSupport.get(view);
  if (supported === undefined) {
    try {
      supported =
        (view as Window & { CSS?: { supports?: (query: string) => boolean } }).CSS?.supports?.(
          'selector(:user-invalid)',
        ) === true;
    } catch {
      supported = false;
    }
    userInvalidSupport.set(view, supported);
  }
  return supported;
}

function isUserInvalid(element: Element, view: Window): boolean | null {
  if (!supportsUserInvalid(view)) return null;
  try {
    return element.matches(':user-invalid');
  } catch {
    return null;
  }
}

function readNative(element: Element, view: Window): NativeFacts {
  const tag = element.localName;
  const none: NativeFacts = {
    isControl: false,
    required: false,
    disabled: false,
    empty: false,
    invalid: false,
    nonPristine: false,
    selectedOption: false,
  };

  // A <label> carries the *requirement* of the control it labels (that is where "required" is drawn).
  if (tag === 'label') {
    const control = (element as HTMLLabelElement).control;
    if (control && FORM_FIELDS.has(control.localName)) {
      const field = control as HTMLInputElement;
      const type = field.type;
      const hidden =
        type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset';
      return { ...none, required: !hidden && field.required && !field.disabled };
    }
    return none;
  }

  if (tag === 'option') {
    const option = element as HTMLOptionElement;
    const select = option.parentElement as HTMLSelectElement | null;
    return {
      ...none,
      disabled: option.disabled,
      selectedOption: option.selected && select?.multiple === true,
    };
  }

  if (tag === 'button') return { ...none, disabled: (element as HTMLButtonElement).disabled };
  if (!FORM_FIELDS.has(tag)) return none;
  const field = element as HTMLInputElement;
  const value = field.value ?? '';
  const invalid = field.willValidate === true && field.validity?.valid === false;
  const userInvalid = invalid ? isUserInvalid(element, view) : null;
  return {
    isControl: true,
    required: field.required === true && field.type !== 'hidden',
    disabled: field.disabled === true,
    empty: value === '',
    invalid,
    // `:user-invalid` knows whether the user has touched the field; without it, a value is the best proxy.
    nonPristine: invalid && (userInvalid ?? value !== ''),
    selectedOption: false,
  };
}

/** Coarse hue name of a CSS color, or null when it is not clearly red/green/yellow/blue. */
export function colorHintOf(css: string): string | null {
  const color = parseColor(css);
  if (!color || color.alpha < 0.5) return null;
  const { r, g, b } = color; // 0-1, sRGB
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0 || lightness < 0.12 || lightness > 0.9) return null;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  if (saturation < 0.4) return null;
  let hue: number;
  if (max === r) hue = ((g - b) / delta + (g < b ? 6 : 0)) * 60;
  else if (max === g) hue = ((b - r) / delta + 2) * 60;
  else hue = ((r - g) / delta + 4) * 60;
  if (hue < 15 || hue >= 345) return 'red';
  if (hue >= 40 && hue < 70) return 'yellow';
  if (hue >= 90 && hue < 160) return 'green';
  if (hue >= 195 && hue < 255) return 'blue';
  return null;
}

function px(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const SIZED_DISPLAYS: ReadonlySet<string> = new Set([
  'inline-block',
  'block',
  'flex',
  'inline-flex',
  'grid',
  'inline-grid',
]);

export const DOT_MIN_PX = 4;
export const DOT_MAX_PX = 64;

function hasIconInside(element: Element): boolean {
  if (element.localName === 'svg' || element.localName === 'img') return true;
  if (element.getAttribute('role') === 'img') return true;
  return (
    element.querySelector(
      'svg, img, [role="img"], i[class], [class*="icon" i], [class*="glyph" i]',
    ) !== null
  );
}

function elementKind(
  element: Element,
  style: CSSStyleDeclaration,
  text: string,
  truncated: boolean,
): ElementKind {
  const tag = element.localName;
  if (INERT_TAGS.has(tag)) return 'other';
  if (CONTROL_TAGS.has(tag)) return 'control';
  const display = style.display;
  if (display === 'none' || display === 'contents' || style.visibility === 'hidden') return 'other';
  if (display.startsWith('table') && display !== 'table-cell') return 'other';
  if (display === 'list-item' && tag !== 'li') return 'other';
  const empty =
    element.childNodes.length === 0 || (text === '' && element.firstElementChild === null);
  if (empty) {
    const width = px(style.width);
    const height = px(style.height);
    const sized =
      SIZED_DISPLAYS.has(display) &&
      width >= DOT_MIN_PX &&
      height >= DOT_MIN_PX &&
      width <= DOT_MAX_PX &&
      height <= DOT_MAX_PX;
    return sized ? 'dot' : 'other';
  }
  // Prose-sized containers are not decorated: a mark on a whole article says nothing.
  return truncated ? 'other' : 'text';
}

/** Everything the semantic core may know about `element`. Cheap attribute reads plus a few computed styles. */
export function readElementFacts(element: Element, env: FactsEnvironment): ElementFacts {
  const style = env.view.getComputedStyle(element);
  const role = effectiveRole(element);
  const { text, truncated } = visibleText(element);

  const aria: Record<string, string> = {};
  for (const name of ARIA_ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (value !== null) aria[name] = value;
  }

  const dataValues: { name: string; value: string }[] = [];
  for (const name of STATE_DATA_ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (value !== null) dataValues.push({ name, value });
  }

  const background = style.backgroundColor;
  const colorHint = colorHintOf(background) ?? colorHintOf(style.color);

  return {
    tag: element.localName,
    role,
    kind: elementKind(element, style, text, truncated),
    classTokens: listTokens(element.getAttribute('class')),
    idTokens: element.id ? [element.id] : [],
    dataValues,
    aria,
    title: element.getAttribute('title') ?? '',
    text,
    textTruncated: truncated,
    labelText: element.getAttribute('aria-label') ?? '',
    describedByText: describedByText(element),
    native: readNative(element, env.view),
    parentClassTokens: listTokens(element.parentElement?.getAttribute('class')),
    isInteractive: isInteractive(element, role),
    colorHint,
    // A prose-sized container is never decorated: do not search it for icons.
    hasIcon: truncated ? false : hasIconInside(element),
    beforeContent: isBusy(env.pseudoContent(element, '::before')),
    afterContent: isBusy(env.pseudoContent(element, '::after')),
  };
}

function isBusy(content: string): boolean {
  return content !== 'none' && content !== 'normal' && content !== '';
}

/** The computed non-paint / paint properties of `element`, for comparing comparable elements. */
export function readStyleSnapshot(
  element: Element,
  view: Window,
  kind: ElementKind,
): StyleSnapshot {
  const style = view.getComputedStyle(element);
  const shape: Record<string, string> = {};
  const paint: Record<string, string> = {};
  // The focus ring is the browser's, not the page's: a focused field must not look "different".
  const focused = element.ownerDocument.activeElement === element;
  for (const name of SHAPE_PROPERTIES) {
    // Text decides the size of a text host; only boxes with no content have a size of their own.
    if (kind === 'text' && (name === 'width' || name === 'height')) continue;
    if (focused && name.startsWith('outline-')) continue;
    shape[name] = style.getPropertyValue(name);
  }
  for (const name of PAINT_PROPERTIES) paint[name] = style.getPropertyValue(name);
  return { shape, paint };
}
