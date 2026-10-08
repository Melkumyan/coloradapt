import type { AnalysisStatus, AnalysisResult, ElementDescriptor } from '@domain/models';
import { ANALYSIS_BUDGET } from '@shared/constants';
import {
  ANALYZER_SELECTOR,
  CORE_ANALYZER_SELECTOR,
  ELEMENT_ID_ATTRIBUTE,
  NON_CANDIDATE_TAGS,
  STYLE_TOKENS_ATTRIBUTE,
} from './constants';
import { readBorders, resolveColors } from './colors';
import { classifyElementRole, classifyStructuralRole, isElementDisabled } from './roles';
import { isElementVisible } from './visibility';
import { hasOwnText } from './text';
import {
  createBackgroundResolutionCache,
  type BackgroundResolutionCache,
} from './background-resolution';
import {
  analyzeSvgUnits,
  collectAnimatedPaintTargets,
  isOutermostSvg,
  isSvgElement,
  outermostSvg,
  type SvgStyleProbe,
} from '../svg';

export interface AnalyzeDocumentOptions {
  readonly root?: ParentNode;
  readonly maxElements?: number;
  readonly maxDurationMs?: number;
  /**
   * Slice budget of an incremental pass (M12.5): a root after the first starts only while the elements of this
   * pass stay within it. Batching only: the first root is still taken whole (up to `maxElements`), so what is
   * analyzed never depends on this value, only in how many passes.
   */
  readonly sliceElements?: number;
  /**
   * What an element weighs against `sliceElements` (default 1): the callers know which elements cost far more than
   * their count says (an inline SVG unit, an element the semantic layer will examine). Batching only.
   */
  readonly sliceWeight?: (element: Element) => number;
  readonly now?: () => number;
  readonly getStyle?: (element: Element) => CSSStyleDeclaration;
  /**
   * Applies a style probe for one synchronous read (see `core/svg/inheritance.ts`).
   * Without it no inline SVG can be told apart as `currentColor` / inherited /
   * explicit, so SVGs are analyzed but never adapted.
   */
  readonly probeStyles?: SvgStyleProbe;
  /** Whether the chart layer (M7) owns an SVG: such an SVG is analyzed but never adapted here. */
  readonly isChartOwned?: (svg: Element) => boolean;
}

let idCounter = 0;

/**
 * Ids this module handed out, by element. An element's `data-coloradapt-id`
 * attribute is trusted only while this registry agrees with it: a clone made
 * with `cloneNode` (or markup copied from an adapted page) carries the
 * attribute but is a different element, and must get an id of its own — two
 * elements sharing one id would share one adaptation rule. A WeakMap, so
 * removed elements (and their ids' bookkeeping) are simply garbage-collected;
 * the counter is a plain number and never retains anything.
 */
const assignedIds = new WeakMap<Element, string>();

function nextElementId(): string {
  idCounter += 1;
  return `ca-${idCounter.toString(36)}`;
}

/** The id this analyzer assigned to `element`, or null (never analyzed, or a foreign/cloned attribute). */
export function getOwnedElementId(element: Element): string | null {
  const id = assignedIds.get(element);
  return id !== undefined && element.getAttribute(ELEMENT_ID_ATTRIBUTE) === id ? id : null;
}

function ensureElementId(element: Element): string {
  const owned = getOwnedElementId(element);
  if (owned) return owned;
  const id = nextElementId();
  assignedIds.set(element, id);
  element.setAttribute(ELEMENT_ID_ATTRIBUTE, id);
  // A clone also carries the original's rule tokens; they are not this element's until the stylesheet says so.
  element.removeAttribute(STYLE_TOKENS_ATTRIBUTE);
  return id;
}

/** How much of an {@link AnalysisRoot} is (re-)analyzed. */
export type AnalysisScope = 'subtree' | 'self';

/** One region of the document to re-analyze incrementally. */
export interface AnalysisRoot {
  readonly element: Element;
  /** `subtree`: the element and every candidate below it. `self`: the element alone. */
  readonly scope: AnalysisScope;
}

/**
 * Owned ids of every analyzed element in `root`'s region. Used to find
 * adaptations whose element is gone from, or no longer eligible in, a
 * re-analyzed region.
 */
export function collectOwnedIds(root: Element, scope: AnalysisScope = 'subtree'): string[] {
  const ids: string[] = [];
  const rootId = getOwnedElementId(root);
  if (rootId) ids.push(rootId);
  if (scope === 'self') return ids;
  for (const node of root.querySelectorAll(`[${ELEMENT_ID_ATTRIBUTE}]`)) {
    const id = getOwnedElementId(node);
    if (id) ids.push(id);
  }
  return ids;
}

function resolveAnalysisStatus(
  backgroundKind: ElementDescriptor['backgroundKind'],
  truncated: boolean,
  approximate: boolean,
): AnalysisStatus {
  if (backgroundKind !== 'solid') return 'unsupported';
  if (truncated || approximate) return 'partial';
  return 'resolved';
}

/** Why a candidate element produced no descriptor (see {@link decideElement}). */
export type SkipReason = 'not-visible' | 'wrapper-without-own-text' | 'no-parseable-color';

/**
 * Decides one candidate element: its descriptor, or the reason it has none. Pure apart from the id it hands
 * out (through `idFor`; a trace passes a no-op so it never marks the page) to an element that qualifies. The reason strings are the debug trace's vocabulary
 * (`core/audit/trace.ts`); a skip allocates nothing.
 *
 * A wrapper (e.g. `<p>`) whose entire visible text lives inside a nested, independently-analyzed element (e.g.
 * `<span>`) would otherwise produce a near-duplicate conflict for the same text, so an element without text of
 * its own is analyzed only when its structural role (link, button, form control, status, badge, ...) makes it
 * relevant by itself. That cheap check runs before the style is read.
 */
export function decideElement(
  element: Element,
  getStyle: (element: Element) => CSSStyleDeclaration,
  backgroundCache: BackgroundResolutionCache,
  idFor: (element: Element) => string = ensureElementId,
): ElementDescriptor | SkipReason {
  const ownText = hasOwnText(element);
  const structural = classifyStructuralRole(element);
  if (!ownText && !structural) return 'wrapper-without-own-text';

  const style = getStyle(element);
  if (!isElementVisible(element, style)) return 'not-visible';

  const resolution = resolveColors(element, getStyle, backgroundCache);
  if (!resolution) return 'no-parseable-color';

  return {
    id: idFor(element),
    tagName: element.tagName.toLowerCase(),
    role: structural ?? classifyElementRole(element),
    colorPair: resolution.colorPair,
    backgroundKind: resolution.backgroundKind,
    analysisStatus: resolveAnalysisStatus(
      resolution.backgroundKind,
      resolution.truncated,
      resolution.approximate,
    ),
    borders: readBorders(element, getStyle),
    isVisible: true,
    hasTextContent: ownText,
    disabled: isElementDisabled(element) || undefined,
  };
}

/** Whether the element's tag can ever be text a visitor reads (not metadata, a script, a template, a UA-styled option). */
export function isCandidateTag(element: Element): boolean {
  return !NON_CANDIDATE_TAGS.has(element.localName);
}

/**
 * Whether a candidate can possibly produce a descriptor: a readable tag, and text of its own or a structural
 * role that makes it relevant by itself. A cheap, style-free test, applied before a candidate is counted
 * against any budget so that the bare wrappers of a modern page (a `<div>` around a `<p>`) cost nothing.
 */
function isWorthDescribing(element: Element): boolean {
  // what is inside an inline SVG belongs to its unit (`core/svg`); only the outermost `<svg>` is a candidate
  if (isSvgElement(element)) return isInlineSvgUnit(element);
  return (
    isCandidateTag(element) && (hasOwnText(element) || classifyStructuralRole(element) !== null)
  );
}

/** The descriptor of one candidate element, or null if it is not visible, not worth analyzing, or has no parseable color. */
function describeElement(
  element: Element,
  getStyle: (element: Element) => CSSStyleDeclaration,
  backgroundCache: BackgroundResolutionCache,
): ElementDescriptor | null {
  const decision = decideElement(element, getStyle, backgroundCache);
  return typeof decision === 'string' ? null : decision;
}

/**
 * An outermost `<svg>` that lives inside an HTML document. A standalone SVG
 * document (the browser showing `icon.svg` itself) is not "inline SVG": there is
 * no `<head>` to hold our `<style>`, so nothing there can be adapted.
 */
function isInlineSvgUnit(element: Element): boolean {
  return isOutermostSvg(element) && element !== element.ownerDocument.documentElement;
}

/**
 * Analyzes the outermost inline SVGs found in a pass as one batch (a single
 * style probe covers them all). Returns descriptors and the nodes that rules
 * target, by id.
 */
function describeSvgBatch(
  svgs: readonly Element[],
  getStyle: (element: Element) => CSSStyleDeclaration,
  backgroundCache: BackgroundResolutionCache,
  probe: SvgStyleProbe | undefined,
  isChartOwned?: (svg: Element) => boolean,
): { descriptors: ElementDescriptor[]; nodes: Map<string, Element> } {
  const descriptors: ElementDescriptor[] = [];
  const nodes = new Map<string, Element>();
  const first = svgs[0];
  if (!first) return { descriptors, nodes };
  const results = analyzeSvgUnits(svgs, {
    getStyle,
    backgroundCache,
    ensureId: ensureElementId,
    probe,
    animatedTargets: collectAnimatedPaintTargets(first.ownerDocument),
    ...(isChartOwned ? { isChartOwned } : {}),
  });
  for (const result of results) {
    if (!result.descriptor) continue;
    descriptors.push(result.descriptor);
    for (const [id, node] of result.nodes) nodes.set(id, node);
  }
  return { descriptors, nodes };
}

/**
 * Performs a single, bounded pass over `root`, extracting a descriptor for
 * every element that is a candidate (see {@link ANALYZER_SELECTOR}), is visible, and has
 * a parseable color. Honors a hard element-count and wall-clock budget
 * (see docs/PERFORMANCE.md) rather than exhaustively walking the DOM.
 */
export function analyzeDocument(options: AnalyzeDocumentOptions = {}): {
  elements: ElementDescriptor[];
  truncated: boolean;
} {
  const root = options.root ?? document;
  const maxElements = options.maxElements ?? ANALYSIS_BUDGET.maxElements;
  const maxDurationMs = options.maxDurationMs ?? ANALYSIS_BUDGET.maxDurationMs;
  const now = options.now ?? (() => performance.now());
  const getStyle = options.getStyle ?? ((el: Element) => getComputedStyle(el));

  const candidates = root.querySelectorAll(ANALYZER_SELECTOR);
  const elements: ElementDescriptor[] = [];
  const backgroundCache = createBackgroundResolutionCache();
  const svgs: Element[] = [];
  const startedAt = now();
  let truncated = false;

  for (let i = 0; i < candidates.length; i += 1) {
    const element = candidates[i];
    // bare wrappers cost nothing, not even a look at the budget
    if (!element || !isWorthDescribing(element)) continue;
    if (elements.length + svgs.length >= maxElements) {
      truncated = true;
      break;
    }
    if (now() - startedAt > maxDurationMs) {
      truncated = true;
      break;
    }

    // An inline SVG is analyzed as one unit; elements inside it are part of it.
    if (isSvgElement(element)) {
      if (isInlineSvgUnit(element)) svgs.push(element);
      continue;
    }

    const descriptor = describeElement(element, getStyle, backgroundCache);
    if (descriptor) elements.push(descriptor);
  }

  elements.push(
    ...describeSvgBatch(svgs, getStyle, backgroundCache, options.probeStyles, options.isChartOwned)
      .descriptors,
  );
  return { elements, truncated };
}

export interface SubtreeAnalysis {
  readonly elements: ElementDescriptor[];
  /** Analyzed element by descriptor id — lets callers avoid document-wide lookups. */
  readonly nodes: ReadonlyMap<string, Element>;
  /** Number of candidate elements inspected (whether or not they qualified). */
  readonly candidatesInspected: number;
  /** How many of the given roots were fully handled; the rest were not started (budget). */
  readonly rootsCompleted: number;
  /** True when one root alone exceeded the element budget (the rest of that root was not analyzed). */
  readonly truncated: boolean;
}

/**
 * Bounded analysis of specific regions only — the incremental counterpart of
 * {@link analyzeDocument} (docs/DYNAMIC_ANALYSIS.md). Same per-element rules,
 * same element budget, but the work is proportional to the roots, not the page.
 *
 * Roots are handled in order and **never cut short except by the structural
 * element budget, and only when one root alone exceeds it**:
 *
 * - the first root of a pass is always started and always finished (up to
 *   `maxElements`); the clock never cuts it (a forced style recalculation on
 *   its first element can take longer than the whole time budget, and
 *   dropping the tail of a root because of that would make the result depend
 *   on the machine);
 * - a later root is started only if the time budget has not run out *and* its
 *   candidates fit in what is left of the element budget; otherwise it is
 *   left, whole, for the next pass (`rootsCompleted` tells the caller where
 *   to resume), where it is the first root.
 *
 * So repeated passes always make progress, and a root that fits the budget is
 * analyzed completely however it is batched with others.
 */
export function analyzeSubtrees(
  roots: readonly AnalysisRoot[],
  options: Omit<AnalyzeDocumentOptions, 'root'> = {},
): SubtreeAnalysis {
  const maxElements = options.maxElements ?? ANALYSIS_BUDGET.maxElements;
  const maxDurationMs = options.maxDurationMs ?? ANALYSIS_BUDGET.maxDurationMs;
  const sliceElements = Math.min(options.sliceElements ?? maxElements, maxElements);
  const weightOf = options.sliceWeight ?? (() => 1);
  /** What this pass has taken so far, in slice units. */
  let weightUsed = 0;
  const used = () => weightUsed;
  const weigh = (list: readonly Element[]) =>
    list.reduce((sum, element) => sum + weightOf(element), 0);
  const now = options.now ?? (() => performance.now());
  const getStyle = options.getStyle ?? ((el: Element) => getComputedStyle(el));

  const elements: ElementDescriptor[] = [];
  const nodes = new Map<string, Element>();
  const backgroundCache = createBackgroundResolutionCache();
  const seen = new Set<Element>();
  const svgs: Element[] = [];
  const startedAt = now();
  let candidatesInspected = 0;
  let rootsCompleted = 0;
  let truncated = false;

  for (const root of roots) {
    const first = rootsCompleted === 0;
    if (!first && (used() >= sliceElements || now() - startedAt > maxDurationMs)) {
      break;
    }

    if (root.element.isConnected) {
      const candidates: Element[] = [];
      // A region inside an inline SVG is re-analyzed as the SVG it belongs to.
      const unit = outermostSvg(root.element);
      if (unit && unit !== root.element) candidates.push(unit);
      // The region's own element is always inspected when it is one the analyzer has always looked at (a `<p>`
      // that just lost its text must still be seen, to drop what was adapted); every element below it is a
      // candidate only if it holds paintable text or a structural role.
      else if (isWorthDescribing(root.element) || root.element.matches(CORE_ANALYZER_SELECTOR)) {
        candidates.push(root.element);
      }
      if (root.scope === 'subtree') {
        for (const node of root.element.querySelectorAll(ANALYZER_SELECTOR)) {
          if (isWorthDescribing(node)) candidates.push(node);
        }
      }
      // Does not fit in what is left: it waits for a pass where it is the first root.
      if (!first && used() + weigh(candidates) > sliceElements) break;

      let rootTruncated = false;
      for (const element of candidates) {
        if (seen.has(element)) continue;
        if (elements.length + svgs.length >= maxElements) {
          rootTruncated = true;
          break;
        }
        seen.add(element);
        candidatesInspected += 1;
        if (isSvgElement(element)) {
          if (isInlineSvgUnit(element)) {
            svgs.push(element);
            weightUsed += weightOf(element);
          }
          continue;
        }
        const descriptor = describeElement(element, getStyle, backgroundCache);
        if (!descriptor) continue;
        elements.push(descriptor);
        weightUsed += weightOf(element);
        nodes.set(descriptor.id, element);
      }
      if (rootTruncated) {
        truncated = true;
        break;
      }
    }
    rootsCompleted += 1;
  }

  const svg = describeSvgBatch(
    svgs,
    getStyle,
    backgroundCache,
    options.probeStyles,
    options.isChartOwned,
  );
  elements.push(...svg.descriptors);
  for (const [id, node] of svg.nodes) nodes.set(id, node);

  return { elements, nodes, candidatesInspected, rootsCompleted, truncated };
}

export function toAnalysisResult(
  url: string,
  pass: { elements: ElementDescriptor[]; truncated: boolean },
  conflicts: AnalysisResult['conflicts'],
  unresolvedCount: number,
): AnalysisResult {
  return {
    url,
    timestamp: Date.now(),
    elements: pass.elements,
    conflicts,
    truncated: pass.truncated,
    unresolvedCount,
  };
}
