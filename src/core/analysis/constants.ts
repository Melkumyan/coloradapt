/** Data attribute used to correlate a DOM element back to an {@link ElementDescriptor}. */
export const ELEMENT_ID_ATTRIBUTE = 'data-coloradapt-id';

/**
 * The selector up to and including M10: interactive and content-bearing elements, status and badge
 * classes. Kept as its own export because the real-world harness replays the pre-M10.R1 audit decision
 * with it (`features/audit/trace.ts`).
 */
export const CORE_ANALYZER_SELECTOR = [
  'a',
  'button',
  '[role="button"]',
  'input',
  'select',
  'textarea',
  'label',
  'svg',
  'img',
  '[role="status"]',
  '[role="alert"]',
  'p',
  'span',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'td',
  'th',
  'strong',
  'em',
  'small',
  'badge',
  '[class*="badge" i]',
  '[class*="status" i]',
  '[class*="tag" i]',
].join(',');

/**
 * Elements the analyzer *queries*: every element. What makes one a candidate is what it holds, not its tag
 * (M10.R1): a text node of its own, or a structural role (link, button, form control, image, status, badge,
 * SVG) that makes it relevant by itself; see `isWorthDescribing` in `dom-analyzer.ts`. The M10 real-world
 * comparison found text directly inside `<div>`, `<time>`, `<abbr>`, `<code>` (279 of the 392 misses) and,
 * in Firefox, inside an unknown `<d>` element (204 rows on one page) never looked at, because the first
 * version listed tags. A tag list can never be complete (custom elements, typos, new HTML).
 *
 * Cheap by construction: an element with neither is rejected by a child-node scan before its style is read
 * and before it counts against any budget.
 */
export const ANALYZER_SELECTOR = '*';

/** Elements that are never text a visitor reads, whatever they contain (document metadata, scripts, UA-styled options). */
export const NON_CANDIDATE_TAGS: ReadonlySet<string> = new Set([
  'html',
  'head',
  'meta',
  'link',
  'title',
  'base',
  'script',
  'style',
  'noscript',
  'template',
  'option',
  'optgroup',
  'datalist',
]);
