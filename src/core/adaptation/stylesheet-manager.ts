import type { AdaptationChange } from '@domain/models';
import { ELEMENT_ID_ATTRIBUTE } from '@core/analysis';
import { parseColor } from '@core/color';
import { verifySvgPaints } from '@core/svg';

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

/** A rule is identified by the element it targets and the property it writes. */
export function ruleKey(change: AdaptationChange): string {
  return `${change.elementId}\u0000${change.property}`;
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
  /** Ids whose rules are dropped (an element, or an owner such as an SVG). Unknown ids are ignored. */
  readonly remove: readonly string[];
}

export interface DeltaApplyResult extends ApplyResult {
  /** Rules that did not exist before and are now in the sheet. */
  readonly added: number;
  /** Existing rules replaced by a different value. */
  readonly updated: number;
  /** Rules dropped — requested removals plus upserts the browser did not honor. */
  readonly removed: number;
  /** Rules dropped because their owner's new rule set no longer includes them. */
  readonly pruned: number;
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
 * The current rule per (element, property) lives in a map, so a rule can be
 * upserted or removed individually (`applyDelta`) and can never be duplicated:
 * updating one element 100 times leaves one rule. An inline SVG's rules target
 * several elements (its `<svg>` and some shapes) but share an *owner*: they are
 * replaced, verified and dropped as one group. The sheet text is regenerated
 * from the map only when the delta changes something.
 */
export class StylesheetManager {
  #doc: Document;
  #styleElement: HTMLStyleElement | null = null;
  /** Rules by {@link ruleKey}. */
  #rules = new Map<string, AdaptationChange>();
  /** Rule keys by element id *and* by owner id: one lookup finds everything an id owns. */
  #index = new Map<string, Set<string>>();
  /**
   * Static CSS of the semantic cues (M6): a pure function of the cue kinds currently in use,
   * keyed on an attribute, so it never needs per-element rules. `null`: no cue on the page.
   */
  #cueCss: string | null = null;

  constructor(doc: Document = document) {
    this.#doc = doc;
  }

  /** Replaces every rule with `changes`. */
  apply(changes: readonly AdaptationChange[]): ApplyResult {
    if (changes.length === 0) {
      this.restore();
      return { applied: [], notApplied: [] };
    }

    this.#clearRules();
    for (const change of changes) this.#setRule(change);
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
    let pruned = 0;
    let dirty = false;
    for (const id of delta.remove) {
      const dropped = this.#deleteRulesOf(id);
      if (dropped > 0) {
        removed += dropped;
        dirty = true;
      }
    }

    // An owner's rules are replaced as a group: whatever it had before and does not
    // submit again (an SVG whose paint moved from one shape to its <svg>) is dropped.
    const submitted = new Map<string, Set<string>>();
    for (const change of delta.upsert) {
      if (change.ownerId === undefined) continue;
      const keys = submitted.get(change.ownerId) ?? new Set<string>();
      keys.add(ruleKey(change));
      submitted.set(change.ownerId, keys);
    }
    for (const [ownerId, keep] of submitted) {
      for (const key of [...(this.#index.get(ownerId) ?? [])]) {
        if (keep.has(key)) continue;
        this.#deleteRule(key);
        pruned += 1;
        dirty = true;
      }
    }

    let added = 0;
    let updated = 0;
    for (const change of delta.upsert) {
      const existing = this.#rules.get(ruleKey(change));
      if (existing?.adaptedValue === change.adaptedValue) continue;
      this.#setRule(change);
      dirty = true;
      if (existing) updated += 1;
      else added += 1;
    }

    if (this.#isEmpty()) {
      this.restore();
      return { applied: [], notApplied: [], added, updated, removed, pruned };
    }
    // Content changed, or the page deleted our <style> out from under us.
    const wasAttached = this.#styleElement?.isConnected === true;
    const styleElement = this.#ensureStyleElement();
    if (dirty || !wasAttached) {
      this.#commit(styleElement, this.#css());
    }

    const { applied, notApplied } = this.#verify(delta.upsert, nodes);
    removed += this.#dropUnapplied(notApplied, styleElement);
    return { applied, notApplied, added, updated, removed, pruned };
  }

  /** Whether any rule targets, or belongs to, `id` (an element, or an owner such as an SVG). */
  has(id: string): boolean {
    return (this.#index.get(id)?.size ?? 0) > 0;
  }

  /** The change behind the rule for `property` on `elementId`, if there is one. */
  ruleFor(elementId: string, property = 'color'): AdaptationChange | undefined {
    return this.#rules.get(`${elementId}\u0000${property}`);
  }

  /** Number of rules currently in the sheet. */
  get ruleCount(): number {
    return this.#rules.size;
  }

  /** Ids of the elements rules target, each once (a snapshot; for diagnostics and tests). */
  ruleIds(): string[] {
    return [...new Set([...this.#rules.values()].map((change) => change.elementId))];
  }

  /**
   * True when rules exist but the page removed our `<style>` element (e.g. a
   * framework re-rendering `<head>`). `reattach` puts them back.
   */
  isDetached(): boolean {
    return !this.#isEmpty() && !this.#styleElement?.isConnected;
  }

  /** Re-injects the sheet from the rule map. */
  reattach(): void {
    if (this.#isEmpty()) return;
    this.#commit(this.#ensureStyleElement(), this.#css());
  }

  /** Whether the sheet holds anything at all (color rules or semantic cue CSS). */
  get hasContent(): boolean {
    return !this.#isEmpty();
  }

  /** The semantic-cue CSS currently in the sheet. */
  get cueCss(): string | null {
    return this.#cueCss;
  }

  /**
   * Replaces the semantic-cue CSS (`null` removes it). Writes nothing when the text is unchanged;
   * otherwise commits once, with transitions suppressed. The sheet disappears when neither color
   * rules nor cue CSS remain.
   */
  setCueCss(css: string | null): void {
    const next = css === '' ? null : css;
    const unchanged = next === this.#cueCss;
    this.#cueCss = next;
    if (this.#isEmpty()) {
      if (this.#styleElement) this.restore();
      return;
    }
    const wasAttached = this.#styleElement?.isConnected === true;
    const styleElement = this.#ensureStyleElement();
    if (!unchanged || !wasAttached) this.#commit(styleElement, this.#css());
  }

  /** The `<style>` element, if one is currently injected — for mutation-ownership checks. */
  get styleElement(): HTMLStyleElement | null {
    return this.#styleElement;
  }

  #css(): string {
    const rules = buildCss([...this.#rules.values()]);
    return this.#cueCss === null
      ? rules
      : rules === ''
        ? this.#cueCss
        : `${rules}\n${this.#cueCss}`;
  }

  #isEmpty(): boolean {
    return this.#rules.size === 0 && this.#cueCss === null;
  }

  #verify(
    changes: readonly AdaptationChange[],
    nodes?: ReadonlyMap<string, Element>,
  ): { applied: AdaptationChange[]; notApplied: AdaptationChange[] } {
    const failed = new Set<AdaptationChange>();
    for (const change of changes) {
      if (!this.#isApplied(change, nodes?.get(change.elementId))) failed.add(change);
    }

    // Rules that share an owner stand or fall together: an SVG half-adapted is not adapted.
    const groups = new Map<string, AdaptationChange[]>();
    for (const change of changes) {
      if (change.ownerId === undefined) continue;
      const group = groups.get(change.ownerId) ?? [];
      group.push(change);
      groups.set(change.ownerId, group);
    }
    for (const [ownerId, group] of groups) {
      const broken =
        group.some((change) => failed.has(change)) || !this.#isOwnerApplied(ownerId, group, nodes);
      if (broken) for (const change of group) failed.add(change);
    }

    const applied: AdaptationChange[] = [];
    const notApplied: AdaptationChange[] = [];
    for (const change of changes) (failed.has(change) ? notApplied : applied).push(change);
    return { applied, notApplied };
  }

  /** Removes the rules the browser did not honor (whole owner groups); returns how many existed. */
  #dropUnapplied(notApplied: readonly AdaptationChange[], styleElement: HTMLStyleElement): number {
    if (notApplied.length === 0) return 0;
    let dropped = 0;
    for (const change of notApplied) {
      dropped += this.#deleteRulesOf(change.ownerId ?? change.elementId);
    }
    if (this.#isEmpty()) this.restore();
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

  /**
   * Runs `read` with `css` added on top of whatever the sheet holds right now
   * (call it inside {@link withOriginalStyles}, so the page's own styles are what
   * the probe sits on). One synchronous style flush in, one out, nothing painted
   * in between; `css` is expected to suppress the transitions it could start
   * (see `buildProbeCss`). Creates the `<style>` element if there is none yet
   * and removes it again if nothing else needs it.
   */
  withProbe<T>(css: string, read: () => T): T {
    const existed = this.#styleElement?.isConnected === true;
    const styleElement = this.#ensureStyleElement();
    const previous = styleElement.textContent ?? '';
    styleElement.textContent = `${previous}\n${css}`;
    this.#flushStyle();
    try {
      return read();
    } finally {
      // The probe leaves with its transition suppression still in effect for one flush, so a
      // page's `transition: fill` has nothing to start from; then the sheet is as it was.
      this.#flushStyle();
      styleElement.textContent = previous;
      if (!existed && this.#isEmpty()) {
        styleElement.remove();
        this.#styleElement = null;
      }
    }
  }

  restore(): void {
    this.#clearRules();
    this.#cueCss = null;
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

  /**
   * The unit-level check for an owner whose rules target several elements: every
   * visible paint of its shapes must read the planned color, whatever rule or
   * local declaration is behind it.
   */
  #isOwnerApplied(
    ownerId: string,
    group: readonly AdaptationChange[],
    nodes?: ReadonlyMap<string, Element>,
  ): boolean {
    const view = this.#doc.defaultView;
    const first = group[0];
    if (!view || !first) return false;
    const owner =
      nodes?.get(ownerId) ??
      this.#doc.querySelector(`[${ELEMENT_ID_ATTRIBUTE}="${escapeAttributeValue(ownerId)}"]`);
    const planned = parseColor(first.adaptedValue);
    if (!owner || !planned) return false;
    return verifySvgPaints(owner, planned, (element) => view.getComputedStyle(element));
  }

  #setRule(change: AdaptationChange): void {
    const key = ruleKey(change);
    this.#deleteRule(key);
    this.#rules.set(key, change);
    for (const id of new Set([change.elementId, change.ownerId ?? change.elementId])) {
      const keys = this.#index.get(id) ?? new Set<string>();
      keys.add(key);
      this.#index.set(id, keys);
    }
  }

  #deleteRule(key: string): boolean {
    const change = this.#rules.get(key);
    if (!change) return false;
    this.#rules.delete(key);
    for (const id of new Set([change.elementId, change.ownerId ?? change.elementId])) {
      const keys = this.#index.get(id);
      keys?.delete(key);
      if (keys?.size === 0) this.#index.delete(id);
    }
    return true;
  }

  /** Drops every rule that targets, or belongs to, `id`; returns how many there were. */
  #deleteRulesOf(id: string): number {
    let dropped = 0;
    for (const key of [...(this.#index.get(id) ?? [])]) if (this.#deleteRule(key)) dropped += 1;
    return dropped;
  }

  #clearRules(): void {
    this.#rules.clear();
    this.#index.clear();
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
