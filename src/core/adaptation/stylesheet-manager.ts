import type { AdaptationChange } from '@domain/models';
import { ELEMENT_ID_ATTRIBUTE, STYLE_TOKENS_ATTRIBUTE, getOwnedElementId } from '@core/analysis';
import { parseColor } from '@core/color';
import { verifySvgPaints } from '@core/svg';

export const STYLE_ELEMENT_ID = 'coloradapt-stylesheet';

/**
 * The transient `<style>` of a delta commit (M12.5): present for one synchronous style flush, never left in the
 * document. It suppresses transitions only on the elements marked with {@link SUPPRESS_ATTRIBUTE}.
 */
export const SUPPRESS_ELEMENT_ID = 'coloradapt-suppress';
const SUPPRESS_ATTRIBUTE = 'data-coloradapt-t';
const SUPPRESS_MARKED = `[${SUPPRESS_ATTRIBUTE}] { transition: none !important; }`;

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

/**
 * What forces the suspension of the sheet for a read. The attributes the sheet (or a layer that writes into it) styles
 * through: an element that has none of them, below or above it, is not touched by the sheet. And the id attribute: an
 * element that was analyzed before may have a page transition in flight, which the suspension stops (it reports the
 * value the transition is heading for, never a mid-flight one); only a region of fresh elements, below fresh
 * ancestors, can be read as it is.
 */
const STYLED_SELECTOR = [
  ELEMENT_ID_ATTRIBUTE,
  STYLE_TOKENS_ATTRIBUTE,
  'data-coloradapt-cue',
  'data-coloradapt-chart-mark',
  'data-coloradapt-chart-legend',
  'data-coloradapt-chart-owned',
  'data-coloradapt-chart-owner',
  'data-coloradapt-chart-node',
  'data-coloradapt-image',
]
  .map((name) => `[${name}]`)
  .join(',');

function escapeAttributeValue(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/** A rule is identified by the element it targets and the property it writes. */
export function ruleKey(change: AdaptationChange): string {
  return `${change.elementId}\u0000${change.property}`;
}

/**
 * The sheet's unit of emission (M12.5): one declaration, shared by every element that gets it. The token is a
 * pure function of the declaration (never of arrival order), so the same page yields the same sheet however
 * its elements were processed. Whitespace is dropped because the attribute is a space-separated list.
 */
function tokenFor(change: AdaptationChange): string {
  return `${change.property}:${change.adaptedValue.replace(/\s+/g, '')}`;
}

function selectorForToken(token: string): string {
  return `[${STYLE_TOKENS_ATTRIBUTE}~="${escapeAttributeValue(token)}"]${SPECIFICITY_BUMP}`;
}

interface Declaration {
  readonly property: string;
  readonly value: string;
  /** Rules (elements) currently subject to it. */
  uses: number;
}

/** One rule per distinct declaration in use, in token order. */
function buildCss(declarations: ReadonlyMap<string, Declaration>): string {
  return [...declarations.keys()]
    .sort()
    .map((token) => {
      const { property, value } = declarations.get(token)!;
      return `${selectorForToken(token)} { ${property}: ${value} !important; }`;
    })
    .join('\n');
}

/** A region a read looks at: the element, and everything below it when the scope is a subtree. */
export interface SuspensionScope {
  readonly element: Element;
  readonly scope: 'subtree' | 'self';
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
 *
 * The sheet has one rule per distinct *declaration* (M12.5), not per element: an element
 * names the declarations it is subject to in `data-coloradapt-s`. Browsers do not index
 * attribute-value selectors, so one rule per element made every style recalculation cost
 * (tagged elements x rules). Adding elements to existing declarations therefore writes only
 * attributes (transitions suppressed for just those elements, `#commitElements`); the sheet text
 * is rewritten only when a declaration appears or goes. The attribute is taken off every element
 * on `restore()` and on a full `apply()`, including nodes the page removed meanwhile.
 */
export class StylesheetManager {
  #doc: Document;
  #styleElement: HTMLStyleElement | null = null;
  /** Rules by {@link ruleKey}. */
  #rules = new Map<string, AdaptationChange>();
  /** Rule keys by element id *and* by owner id: one lookup finds everything an id owns. */
  #index = new Map<string, Set<string>>();
  /** The declarations the sheet emits, by token (one rule each, however many elements share it). */
  #declarations = new Map<string, Declaration>();
  /** Each element's tokens by property: what its {@link STYLE_TOKENS_ATTRIBUTE} must say. */
  #tokensOf = new Map<string, Map<string, string>>();
  /** Elements whose attribute is not yet in line with `#tokensOf`. */
  #dirty = new Set<string>();
  /** Where an element with tokens was last seen: weak, so a removed element is never kept alive by it. */
  #seen = new Map<string, WeakRef<Element>>();
  /** All tagged elements by id, collected at most once per operation and dropped at its end. */
  #sweep: Map<string, Element> | null = null;
  /**
   * Static CSS of the semantic cues (M6): a pure function of the cue kinds currently in use,
   * keyed on an attribute, so it never needs per-element rules. `null`: no cue on the page.
   */
  #cueCss: string | null = null;
  /**
   * Static CSS of the chart layer (M7): attribute-keyed rules for the series it adapts
   * (`stroke-dasharray`, markers, pattern fills). `null`: no chart is adapted.
   */
  #chartCss: string | null = null;

  constructor(doc: Document = document) {
    this.#doc = doc;
  }

  /** Replaces every rule with `changes`. */
  apply(changes: readonly AdaptationChange[]): ApplyResult {
    if (changes.length === 0) {
      this.restore();
      return { applied: [], notApplied: [] };
    }

    try {
      // A full apply replaces everything, tokens left by an earlier script instance included.
      this.#stripAttributes();
      this.#clearRules();
      for (const change of changes) this.#setRule(change);
      const styleElement = this.#ensureStyleElement();
      this.#syncAttributes();
      this.#commit(styleElement, this.#css());

      const { applied, notApplied } = this.#verify(changes);
      this.#dropUnapplied(notApplied, styleElement);
      return { applied, notApplied };
    } finally {
      this.#sweep = null;
    }
  }

  /**
   * Updates individual rules without touching the others. `nodes` (element by
   * id) saves the document-wide lookup when the caller already holds them.
   * Re-submitting an unchanged rule rewrites nothing but is still verified
   * against the browser, so a page that has since out-ranked it is noticed.
   */
  applyDelta(delta: RuleDelta, nodes?: ReadonlyMap<string, Element>): DeltaApplyResult {
    try {
      return this.#applyDelta(delta, nodes);
    } finally {
      this.#sweep = null;
    }
  }

  #applyDelta(delta: RuleDelta, nodes?: ReadonlyMap<string, Element>): DeltaApplyResult {
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
    const changed = this.#syncAttributes(nodes);
    if (dirty || !wasAttached) {
      const css = this.#css();
      // Same declarations as the sheet already holds (the elements merely joined or left a rule): the sheet text
      // is not rewritten, because any rewrite restyles every tagged element however little changed.
      if (wasAttached && styleElement.textContent === css) this.#commitElements(changed);
      else this.#commit(styleElement, css);
    }

    const { applied, notApplied } = this.#verify(delta.upsert, nodes);
    removed += this.#dropUnapplied(notApplied, styleElement, nodes);
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

  /** The chart CSS currently in the sheet. */
  get chartCss(): string | null {
    return this.#chartCss;
  }

  /**
   * Replaces the chart CSS (`null` removes it); same contract as {@link setCueCss}. The chart
   * layer writes its nodes first and the CSS second, then checks the browser's computed result.
   */
  setChartCss(css: string | null): void {
    const next = css === '' ? null : css;
    const unchanged = next === this.#chartCss;
    this.#chartCss = next;
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
    return [buildCss(this.#declarations), this.#cueCss, this.#chartCss]
      .filter((part): part is string => part !== null && part !== '')
      .join('\n');
  }

  #isEmpty(): boolean {
    return this.#rules.size === 0 && this.#cueCss === null && this.#chartCss === null;
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
  #dropUnapplied(
    notApplied: readonly AdaptationChange[],
    styleElement: HTMLStyleElement,
    nodes?: ReadonlyMap<string, Element>,
  ): number {
    if (notApplied.length === 0) return 0;
    let dropped = 0;
    for (const change of notApplied) {
      dropped += this.#deleteRulesOf(change.ownerId ?? change.elementId);
    }
    if (this.#isEmpty()) this.restore();
    else {
      this.#syncAttributes(nodes);
      this.#commit(styleElement, this.#css());
    }
    return dropped;
  }

  /**
   * Commits elements whose token attribute changed while the sheet text stays as it is. Transitions are
   * suppressed exactly where this flush can change a computed value, the elements and the tagged elements below
   * them (which inherit), by a marker attribute and a transient `<style>`; both are gone before the task ends.
   * The cost follows the elements, not the page.
   */
  #commitElements(changed: readonly Element[]): void {
    if (changed.length === 0) return;
    const marked = new Set<Element>();
    for (const element of changed) {
      marked.add(element);
      if (element.firstElementChild === null) continue;
      for (const below of element.querySelectorAll(`[${ELEMENT_ID_ATTRIBUTE}]`)) marked.add(below);
    }
    for (const element of marked) element.setAttribute(SUPPRESS_ATTRIBUTE, '');
    const suppress = this.#doc.createElement('style');
    suppress.id = SUPPRESS_ELEMENT_ID;
    suppress.textContent = SUPPRESS_MARKED;
    (this.#doc.head ?? this.#doc.documentElement).appendChild(suppress);
    try {
      this.#flushStyle();
    } finally {
      suppress.remove();
      for (const element of marked) element.removeAttribute(SUPPRESS_ATTRIBUTE);
    }
  }

  /**
   * Brings every changed element's {@link STYLE_TOKENS_ATTRIBUTE} in line with its rules. An element that is
   * gone is skipped (nothing to style); the attribute is written only when its value differs. Returns the live
   * elements whose attribute changed.
   */
  #syncAttributes(nodes?: ReadonlyMap<string, Element>): Element[] {
    const changed: Element[] = [];
    for (const id of this.#dirty) {
      const tokens = this.#tokensOf.get(id);
      if (!tokens || tokens.size === 0) {
        // An element that left the page is cleaned too: the page may put the same node back.
        const gone = this.#nodeFor(id, nodes?.get(id), true);
        this.#seen.delete(id);
        if (gone?.hasAttribute(STYLE_TOKENS_ATTRIBUTE)) {
          gone.removeAttribute(STYLE_TOKENS_ATTRIBUTE);
          if (gone.isConnected) changed.push(gone);
        }
        continue;
      }
      const node = this.#nodeFor(id, nodes?.get(id));
      if (!node) continue;
      this.#seen.set(id, new WeakRef(node));
      const value = [...tokens.values()].sort().join(' ');
      if (node.getAttribute(STYLE_TOKENS_ATTRIBUTE) !== value) {
        node.setAttribute(STYLE_TOKENS_ATTRIBUTE, value);
        changed.push(node);
      }
    }
    this.#dirty.clear();
    return changed;
  }

  /**
   * The live element behind an id: the one the caller holds, the one last seen, or, only when neither is
   * known, a single document-wide collection per operation (never one lookup per id).
   */
  #nodeFor(id: string, known?: Element, detached = false): Element | null {
    if (known?.isConnected) return known;
    const seen = this.#seen.get(id);
    if (seen) {
      const node = seen.deref();
      return node && (detached || node.isConnected) ? node : null;
    }
    if (!this.#sweep) {
      this.#sweep = new Map();
      for (const node of this.#doc.querySelectorAll(`[${ELEMENT_ID_ATTRIBUTE}]`)) {
        const owned = getOwnedElementId(node);
        if (owned) this.#sweep.set(owned, node);
        else {
          // Not handed out by the analyzer (a clone's stale copy, or a hand-tagged element): only if nothing owns the id.
          const raw = node.getAttribute(ELEMENT_ID_ATTRIBUTE) ?? '';
          if (!this.#sweep.has(raw)) this.#sweep.set(raw, node);
        }
      }
    }
    return this.#sweep.get(id) ?? null;
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
  withOriginalStyles<T>(read: () => T, scope?: readonly SuspensionScope[]): T {
    const styleElement = this.#styleElement;
    if (!styleElement || !styleElement.isConnected) return read();
    // M12.5: swapping the sheet restyles every tagged element (cost grows with the page, not with the work), so a
    // read that provably cannot see the sheet does not swap it.
    if (scope && !this.#mayBeStyled(scope)) return read();

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

  /**
   * Whether the sheet can influence what a read of `scope` sees: an element of the region, or one of its ancestors
   * (which it inherits from), carries a styling attribute, or the region sits in an inline SVG (read as a unit).
   */
  #mayBeStyled(scope: readonly SuspensionScope[]): boolean {
    for (const { element, scope: extent } of scope) {
      if (!element.isConnected) continue;
      if (element.closest('svg') !== null) return true;
      for (let node: Element | null = element; node; node = node.parentElement) {
        if (node.matches(STYLED_SELECTOR)) return true;
      }
      if (extent === 'subtree' && element.querySelector(STYLED_SELECTOR) !== null) return true;
    }
    return false;
  }

  /**
   * Takes {@link STYLE_TOKENS_ATTRIBUTE} off every element: the ones in the document, and the ones the page has taken
   * out meanwhile (it may put the same node back).
   */
  #stripAttributes(): void {
    this.#dirty.clear();
    this.#sweep = null;
    for (const ref of this.#seen.values()) ref.deref()?.removeAttribute(STYLE_TOKENS_ATTRIBUTE);
    this.#seen.clear();
    for (const node of this.#doc.querySelectorAll(`[${STYLE_TOKENS_ATTRIBUTE}]`)) {
      node.removeAttribute(STYLE_TOKENS_ATTRIBUTE);
    }
  }

  restore(): void {
    this.#clearRules();
    // The tokens leave with the rules; the page's elements are as they were (but for their id).
    this.#stripAttributes();
    this.#cueCss = null;
    this.#chartCss = null;
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
    const node = this.#nodeFor(change.elementId, known);
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
    const owner = this.#nodeFor(ownerId, nodes?.get(ownerId));
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
    const token = tokenFor(change);
    const declaration = this.#declarations.get(token);
    if (declaration) declaration.uses += 1;
    else {
      this.#declarations.set(token, {
        property: change.property,
        value: change.adaptedValue,
        uses: 1,
      });
    }
    const tokens = this.#tokensOf.get(change.elementId) ?? new Map<string, string>();
    tokens.set(change.property, token);
    this.#tokensOf.set(change.elementId, tokens);
    this.#dirty.add(change.elementId);
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
    const token = tokenFor(change);
    const declaration = this.#declarations.get(token);
    if (declaration && (declaration.uses -= 1) <= 0) this.#declarations.delete(token);
    const tokens = this.#tokensOf.get(change.elementId);
    tokens?.delete(change.property);
    if (tokens?.size === 0) this.#tokensOf.delete(change.elementId);
    this.#dirty.add(change.elementId);
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
    this.#declarations.clear();
    this.#tokensOf.clear();
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
