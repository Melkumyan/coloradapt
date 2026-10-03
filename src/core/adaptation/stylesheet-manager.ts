import type { AdaptationChange } from '@domain/models';
import { ELEMENT_ID_ATTRIBUTE } from '@core/analysis';
import { parseColor } from '@core/color';

const STYLE_ELEMENT_ID = 'coloradapt-stylesheet';

/**
 * Tolerance when comparing the browser's computed color with the planned one.
 * Computed `color` is 8-bit, and so is every planned color; half a step only
 * absorbs float formatting.
 */
const APPLIED_TOLERANCE = 0.5 / 255;

/**
 * Raises the rule's specificity to (1,1,0) without naming a real id (the
 * `:not()` argument never matches), so a plain `#id { color }` — normal or
 * `!important` — cannot out-rank an adaptation. Inline `!important` and
 * deeper id chains still win; those are detected, not fought
 * (docs/ADAPTATION_ENGINE.md, "CSS application policy").
 */
const SPECIFICITY_BUMP = ':not(#coloradapt-specificity)';

/**
 * Suppresses every `transition` on tagged elements. Used only for the
 * duration of one synchronous style flush, never left in the document.
 */
const SUPPRESS_TRANSITIONS = `[${ELEMENT_ID_ATTRIBUTE}] { transition: none !important; }`;

function escapeAttributeValue(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

function selectorFor(change: AdaptationChange): string {
  return `[${ELEMENT_ID_ATTRIBUTE}="${escapeAttributeValue(change.elementId)}"]${SPECIFICITY_BUMP}`;
}

function buildRule(change: AdaptationChange): string {
  return `${selectorFor(change)} { ${change.property}: ${change.adaptedValue} !important; }`;
}

function buildCss(changes: readonly AdaptationChange[]): string {
  return changes.map(buildRule).join('\n');
}

export interface ApplyResult {
  /** Changes whose planned value the browser reports as the element's computed value. */
  readonly applied: readonly AdaptationChange[];
  /** Changes the browser did not honor; their rules are not left in the stylesheet. */
  readonly notApplied: readonly AdaptationChange[];
}

/**
 * Applies/restores adaptation changes via a single injected `<style>`
 * element, never inline styles. Restoring is just removing that element —
 * the page's own DOM and styles are never otherwise touched (aside from
 * the `data-coloradapt-id` attribute the DOM Analyzer adds for targeting).
 *
 * Every transition between style states (apply, restore, re-analysis) is
 * committed with the page's transitions suppressed for one synchronous style
 * flush, so a page's own `transition: color` can neither fade the adaptation
 * in/out nor leave a mid-flight value behind. The suppression rule is
 * removed again before the task ends, so it is fully reversible.
 *
 * `apply` reads the browser's computed values back and reports what was not
 * honored: a plan is never trusted over the real cascade.
 */
export class StylesheetManager {
  #doc: Document;
  #styleElement: HTMLStyleElement | null = null;

  constructor(doc: Document = document) {
    this.#doc = doc;
  }

  apply(changes: readonly AdaptationChange[]): ApplyResult {
    if (changes.length === 0) {
      this.restore();
      return { applied: [], notApplied: [] };
    }

    const styleElement = this.#ensureStyleElement();
    this.#commit(styleElement, buildCss(changes));

    const applied: AdaptationChange[] = [];
    const notApplied: AdaptationChange[] = [];
    for (const change of changes) {
      (this.#isApplied(change) ? applied : notApplied).push(change);
    }

    if (notApplied.length > 0) {
      if (applied.length === 0) this.restore();
      else this.#commit(styleElement, buildCss(applied));
    }
    return { applied, notApplied };
  }

  /**
   * Runs `read` with the page's original styles in effect, then puts the
   * adaptation back — synchronously, so nothing is painted in between.
   * Analysis must go through this: reading computed colors while our own
   * rules are applied would treat adapted colors as the originals and
   * compound the adaptation on every scan. While suspended, tagged elements
   * get `transition: none` so a page's own `color` transition cannot make
   * `getComputedStyle` report a mid-flight (adapted) value; the adaptation
   * is put back with the same suppression, so it does not fade in again.
   */
  withOriginalStyles<T>(read: () => T): T {
    const styleElement = this.#styleElement;
    if (!styleElement || !styleElement.isConnected) return read();

    const adaptedCss = styleElement.textContent;
    styleElement.textContent = SUPPRESS_TRANSITIONS;
    try {
      return read();
    } finally {
      this.#commit(styleElement, adaptedCss);
    }
  }

  restore(): void {
    const styleElement = this.#styleElement;
    if (styleElement?.isConnected) {
      // Original colors return with transitions suppressed, then the sheet goes.
      styleElement.textContent = SUPPRESS_TRANSITIONS;
      this.#flushStyle();
    }
    styleElement?.remove();
    this.#styleElement = null;
  }

  /** Sets `css`, flushing style once with transitions suppressed so no transition starts. */
  #commit(styleElement: HTMLStyleElement, css: string | null): void {
    const target = css ?? '';
    styleElement.textContent = `${target}\n${SUPPRESS_TRANSITIONS}`;
    this.#flushStyle();
    styleElement.textContent = target;
  }

  #flushStyle(): void {
    const view = this.#doc.defaultView;
    if (view) void view.getComputedStyle(this.#doc.documentElement).color;
  }

  #isApplied(change: AdaptationChange): boolean {
    const view = this.#doc.defaultView;
    const node = this.#doc.querySelector(selectorFor(change));
    if (!view || !node) return false;

    const computed = parseColor(view.getComputedStyle(node).getPropertyValue(change.property));
    const planned = parseColor(change.adaptedValue);
    return (
      computed !== null &&
      planned !== null &&
      computed.alpha >= 0.999 &&
      Math.abs(computed.r - planned.r) <= APPLIED_TOLERANCE &&
      Math.abs(computed.g - planned.g) <= APPLIED_TOLERANCE &&
      Math.abs(computed.b - planned.b) <= APPLIED_TOLERANCE
    );
  }

  #ensureStyleElement(): HTMLStyleElement {
    if (this.#styleElement && this.#styleElement.isConnected) {
      return this.#styleElement;
    }

    const existing = this.#doc.getElementById(STYLE_ELEMENT_ID);
    if (existing instanceof HTMLStyleElement) {
      this.#styleElement = existing;
      return existing;
    }

    const element = this.#doc.createElement('style');
    element.id = STYLE_ELEMENT_ID;
    this.#doc.head.appendChild(element);
    this.#styleElement = element;
    return element;
  }
}
