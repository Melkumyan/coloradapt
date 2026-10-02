/** Data attribute used to correlate a DOM element back to an {@link ElementDescriptor}. */
export const ELEMENT_ID_ATTRIBUTE = 'data-coloradapt-id';

/**
 * Elements worth inspecting. Deliberately narrow — the analyzer should not
 * walk every node in the document, only ones likely to carry meaningful
 * foreground/background color information.
 */
export const ANALYZER_SELECTOR = [
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
