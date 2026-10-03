import type { AdaptationChange } from '@domain/models';
import { ELEMENT_ID_ATTRIBUTE } from '@core/analysis';
import { parseColor } from '@core/color';

export const STYLE_ELEMENT_ID = 'coloradapt-stylesheet';

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

export interface RuleDelta {
  /** Rules to add, or to replace when the element already has one. */
  readonly upsert: readonly AdaptationChange[];
  /** Element ids whose rule is dropped. Unknown ids are ignored. */
  readonly remove: readonly string[];
}

export interface DeltaApplyResult extends ApplyResult {
  /** Rules that did not exist before and are now in the sheet. */
  readonly added: number;
  /** Existing rules replaced by a different value. */
  readonly updated: number;
  /** Rules dropped — requested removals plus upserts the browser did not honor. */
  readonly removed: number;
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
 *
 * The current rule per element lives in a map keyed by element id, so a
 * rule can be upserted or removed individually (`applyDelta`) and can never
 * be duplicated: updating one element 100 times leaves one rule. The sheet
 * text is regenerated from that map only when the delta changes something.
 */
export class StylesheetManager {
  #doc: Document;
  #styleElement: HTMLStyleElement | null = null;
  #rules = new Map<string, AdaptationChange>();

  constructor(doc: Document = document) {
    this.#doc = doc;
  }

  /** Replaces every rule with `changes`. */
  apply(changes: readonly AdaptationChange[]): ApplyResult {
    if (changes.length === 0) {
      this.restore();
      return { applied: [], notApplied: [] };
    }

    this.#rules = new Map(changes.map((change) => [change.elementId, change]));
    const styleElement = this.#ensureStyleElement();
    this.#commit(styleElement, this.#css());

    const { applied, notApplied } = this.#verify(changes);
    this.#dropUnapplied(notApplied, styleElement);
    return { applied, notApplied };
  }

  /**
   * Updates individual rules without touching the others. `nodes` (element by
   * id) saves the document-wide lookup when the caller already holds them.
   * Re-submitting an unchanged rule rewrites nothing but is still verified
   * against the browser, so a page that has since out-ranked it is noticed.
   */
  applyDelta(delta: RuleDelta, nodes?: ReadonlyMap<string, Element>): DeltaApplyResult {
    let removed = 0;
    let dirty = false;
    for (const id of delta.remove) {
      if (this.#rules.delete(id)) {
        removed += 1;
        dirty = true;
      }
    }

    let added = 0;
    let updated = 0;
    for (const change of delta.upsert) {
      const existing = this.#rules.get(change.elementId);
      if (existing?.property === change.property && existing.adaptedValue === change.adaptedValue) {
        continue;
      }
      this.#rules.set(change.elementId, change);
      dirty = true;
      if (existing) updated += 1;
      else added += 1;
    }

    if (this.#rules.size === 0) {
      this.restore();
      return { applied: [], notApplied: [], added, updated, removed };
    }
    // Content changed, or the page deleted our <style> out from under us.
    const wasAttached = this.#styleElement?.isConnected === true;
    const styleElement = this.#ensureStyleElement();
    if (dirty || !wasAttached) {
      this.#commit(styleElement, this.#css());
    }

    const { applied, notApplied } = this.#verify(delta.upsert, nodes);
    removed += this.#dropUnapplied(notApplied, styleElement);
    return { applied, notApplied, added, updated, removed };
  }

  /** Whether an adaptation rule currently exists for `elementId`. */
  has(elementId: string): boolean {
    return this.#rules.has(elementId);
  }

  /** The change behind a rule, if that element has one. */
  ruleFor(elementId: string): AdaptationChange | undefined {
    return this.#rules.get(elementId);
  }

  /** Number of rules currently in the sheet. */
  get ruleCount(): number {
    return this.#rules.size;
  }

  /** Ids with a rule (a snapshot; for diagnostics and tests). */
  ruleIds(): string[] {
    return [...this.#rules.keys()];
  }

  /**
   * True when rules exist but the page removed our `<style>` element (e.g. a
   * framework re-rendering `<head>`). `reattach` puts them back.
   */
  isDetached(): boolean {
    return this.#rules.size > 0 && !this.#styleElement?.isConnected;
  }

  /** Re-injects the sheet from the rule map. */
  reattach(): void {
    if (this.#rules.size === 0) return;
    this.#commit(this.#ensureStyleElement(), this.#css());
  }

  /** The `<style>` element, if one is currently injected — for mutation-ownership checks. */
  get styleElement(): HTMLStyleElement | null {
    return this.#styleElement;
  }

  #css(): string {
    return buildCss([...this.#rules.values()]);
  }

  #verify(
    changes: readonly AdaptationChange[],
    nodes?: ReadonlyMap<string, Element>,
  ): { applied: AdaptationChange[]; notApplied: AdaptationChange[] } {
    const applied: AdaptationChange[] = [];
    const notApplied: AdaptationChange[] = [];
    for (const change of changes) {
      (this.#isApplied(change, nodes?.get(change.elementId)) ? applied : notApplied).push(change);
    }
    return { applied, notApplied };
  }

  /** Removes the rules the browser did not honor; returns how many existed. */
  #dropUnapplied(notApplied: readonly AdaptationChange[], styleElement: HTMLStyleElement): number {
    if (notApplied.length === 0) return 0;
    let dropped = 0;
    for (const change of notApplied) if (this.#rules.delete(change.elementId)) dropped += 1;
    if (this.#rules.size === 0) this.restore();
    else this.#commit(styleElement, this.#css());
    return dropped;
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
    this.#rules.clear();
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

  #isApplied(change: AdaptationChange, known?: Element): boolean {
    const view = this.#doc.defaultView;
    const node = known?.isConnected ? known : this.#doc.querySelector(selectorFor(change));
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
