import { detectLegend, type ChartAnalysis, type ChartFacts } from '@core/charts';
import { identifierSegments, type SemanticResult } from '@core/semantics';
import {
  SEMANTIC_ARIA_ATTRIBUTES,
  SEMANTIC_LIMITS,
  coarseColorName,
  type RawChart,
  type SemanticFacts,
  type SemanticTask,
} from '@core/semantic-ai';
import {
  isFieldElement,
  isInteractiveElement,
  isSensitiveElement,
  readTextSnippet,
} from './element-locator';

/**
 * The only place the page is read for the AI-assisted review (docs/AI_PRIVACY.md, "Reading the
 * page"). It reads a handful of allowlisted things about one element and its neighbours and returns
 * plain data; the core re-bounds and redacts all of it again. Never read here: a form control's value
 * or text, `data-*` attributes, ids, URLs (`href`, `src`), cookies, storage, or any text beyond
 * the snippets below.
 */

const SNIPPET = 160;
const NEARBY_SNIPPET = 80;
const PEER_SNIPPET = 40;
const INPUT_TYPE = /^[a-z]{1,16}$/;

/** Text a field's user typed or chose is theirs, and so is anything inside an editable region. */
function textOf(element: Element, limit: number): string | null {
  if (isSensitiveElement(element)) return null;
  const text = readTextSnippet(element, limit).replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

function ariaOf(element: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of SEMANTIC_ARIA_ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (value !== null) out[name] = value.trim().toLowerCase();
  }
  return out;
}

function classSegments(element: Element): string[] {
  const segments: string[] = [];
  for (const token of Array.from(element.classList).slice(0, 8)) {
    for (const segment of identifierSegments(token.slice(0, 40))) {
      if (segment.length <= 24 && !segments.includes(segment)) segments.push(segment);
      if (segments.length >= 12) return segments;
    }
  }
  return segments;
}

function nearbyLabels(element: Element): string[] {
  const out: string[] = [];
  const push = (text: string | null): void => {
    if (text && !out.includes(text) && out.length < SEMANTIC_LIMITS.nearbyLabels) out.push(text);
  };
  for (const sibling of [element.previousElementSibling, element.nextElementSibling]) {
    if (sibling && !isSensitiveElement(sibling)) push(textOf(sibling, NEARBY_SNIPPET));
  }
  const parent = element.parentElement;
  if (parent) {
    const label = parent.getAttribute('aria-label');
    if (label && !isSensitiveElement(parent)) push(label.trim().slice(0, NEARBY_SNIPPET));
    const heading = parent.closest(
      'section, article, fieldset, nav, [role="group"], [role="tablist"]',
    );
    const caption = heading?.querySelector(
      ':scope > h1, :scope > h2, :scope > h3, :scope > legend, :scope > caption',
    );
    if (caption) push(textOf(caption, NEARBY_SNIPPET));
  }
  return out;
}

function peersOf(element: Element): SemanticFacts['peers'] {
  const parent = element.parentElement;
  if (!parent) return [];
  const peers: SemanticFacts['peers'][number][] = [];
  // Walk the siblings without copying them: a list of thousands stops at the twelfth peer.
  for (let child = parent.firstElementChild; child; child = child.nextElementSibling) {
    if (child === element || child.localName !== element.localName) continue;
    peers.push({
      tag: child.localName,
      role: child.getAttribute('role'),
      name: textOf(child, PEER_SNIPPET),
      state: null,
    });
    if (peers.length >= SEMANTIC_LIMITS.peerDescriptors) break;
  }
  return peers;
}

function hiddenFromAT(element: Element): boolean {
  return element.closest('[aria-hidden="true"]') !== null;
}

/** Declared presentational by the author: `role="presentation"` / `"none"`, or an image with an empty `alt`. */
function presentational(element: Element): boolean {
  const role = element.getAttribute('role');
  return (
    role === 'presentation' ||
    role === 'none' ||
    (element.localName === 'img' && element.getAttribute('alt') === '')
  );
}

function nameOf(element: Element, field: boolean): string | null {
  if (field) return null;
  const label = element.getAttribute('aria-label');
  if (label && label.trim() !== '') return label.trim().slice(0, SNIPPET);
  if (element.localName === 'img')
    return element.getAttribute('alt')?.trim().slice(0, SNIPPET) || null;
  const title = element.querySelector(':scope > title');
  if (title?.textContent && title.textContent.trim() !== '')
    return title.textContent.trim().slice(0, SNIPPET);
  // An icon inside a control is named by the control.
  const owner = element.closest(
    'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"]',
  );
  return textOf(owner ?? element, SNIPPET);
}

function base(element: Element, task: SemanticTask, ruleId: string) {
  const field = isFieldElement(element) || isSensitiveElement(element);
  const type =
    element.localName === 'input' ? (element.getAttribute('type')?.toLowerCase() ?? 'text') : null;
  return {
    task,
    ruleId,
    tag: element.localName,
    role: element.getAttribute('role'),
    controlType: type !== null && INPUT_TYPE.test(type) ? type : null,
    aria: ariaOf(element),
    accessibleName: nameOf(element, field),
    title: field ? null : (element.getAttribute('title')?.trim().slice(0, SNIPPET) ?? null),
    isField: field,
    interactive: isInteractiveElement(element),
    hiddenFromAT: hiddenFromAT(element),
    presentational: presentational(element),
    nearbyLabels: nearbyLabels(element),
    peers: peersOf(element),
    classSegments: classSegments(element),
  };
}

/** CA-SEM-002: a state the semantic layer inferred and color alone carries. */
export function readStateFacts(
  element: Element,
  task: SemanticTask,
  result: SemanticResult,
  colorOnly: boolean | null,
): SemanticFacts {
  return {
    ...base(element, task, 'CA-SEM-002'),
    colorRelation:
      colorOnly === null
        ? 'not-compared'
        : colorOnly
          ? 'color-only-difference'
          : 'no-difference-found',
    signals: result.evidence.map((item) => ({
      source: item.source,
      value: item.value,
      strength: item.strength,
      supports: item.supports,
    })),
    chart: null,
    image: null,
  };
}

/** CA-SVG-002, CA-CHART-003/004, CA-IMG-002/003: a graphic whose meaning the DOM may or may not name. */
export function readGraphicFacts(
  element: Element,
  task: SemanticTask,
  ruleId: string,
  image: { classification: string; small: boolean } | null,
): SemanticFacts {
  return {
    ...base(element, task, ruleId),
    colorRelation: 'not-compared',
    signals: [],
    chart: null,
    image,
  };
}

/** The legend entry the audit asks about: the first one two series (or none) could be. */
function pickLegendEntry(
  items: ReturnType<typeof detectLegend>['items'],
  series: readonly { paintKey: string }[],
): { index: number; label: string; paintKey: string | null } | null {
  let first: { index: number; label: string; paintKey: string | null } | null = null;
  for (const [index, item] of items.entries()) {
    const entry = { index: index + 1, label: item.label, paintKey: item.paintKey };
    first ??= entry;
    const matches = series.filter((s) => s.paintKey === item.paintKey).length;
    if (matches !== 1) return entry;
  }
  return first;
}

/** CA-CHART-002: which series does an ambiguous legend entry belong to? `null` when the chart has no legend entry to ask about. */
export function readChartFacts(
  svg: Element,
  analysis: ChartAnalysis,
  facts: ChartFacts,
): SemanticFacts | null {
  if (analysis.status !== 'supported' && analysis.status !== 'limited') return null;
  const chart = analysis.chart;
  const items = detectLegend(facts).items;
  const entry = pickLegendEntry(items, chart.series);
  if (!entry) return null;
  const legendItem = items[entry.index - 1];
  const raw: RawChart = {
    chartType: chart.type,
    legendEntry: entry.label,
    legendIndex: entry.index,
    legendCount: items.length,
    swatchColorName: legendItem?.color ? coarseColorName(legendItem.color) : null,
    series: chart.series.slice(0, 12).map((series) => ({
      title: series.label,
      colorName: coarseColorName(series.color),
    })),
  };
  return {
    ...base(svg, 'MAP_CHART_LABEL', 'CA-CHART-002'),
    colorRelation: 'not-compared',
    signals: [],
    chart: raw,
    image: null,
  };
}
