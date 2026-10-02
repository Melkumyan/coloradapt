import type { AnalysisStatus, AnalysisResult, ElementDescriptor } from '@domain/models';
import { ANALYSIS_BUDGET } from '@shared/constants';
import { ANALYZER_SELECTOR, ELEMENT_ID_ATTRIBUTE } from './constants';
import { readBorders, resolveColors } from './colors';
import { classifyElementRole, isElementDisabled } from './roles';
import { isElementVisible } from './visibility';
import { hasOwnText } from './text';
import { createBackgroundResolutionCache } from './background-resolution';

export interface AnalyzeDocumentOptions {
  readonly root?: ParentNode;
  readonly maxElements?: number;
  readonly maxDurationMs?: number;
  readonly now?: () => number;
  readonly getStyle?: (element: Element) => CSSStyleDeclaration;
}

let idCounter = 0;

function nextElementId(): string {
  idCounter += 1;
  return `ca-${idCounter.toString(36)}`;
}

/**
 * Roles whose text (if any) is never considered redundant with a wrapper's:
 * they're analyzed for their own sake (interactive affordance, status,
 * decoration) even when all of their visible text actually lives in a
 * nested element.
 */
function isAlwaysRelevantRole(role: ElementDescriptor['role']): boolean {
  return role !== 'text' && role !== 'generic';
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

/**
 * Performs a single, bounded pass over `root`, extracting a descriptor for
 * every element that matches {@link ANALYZER_SELECTOR}, is visible, and has
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
  const startedAt = now();
  let truncated = false;

  for (let i = 0; i < candidates.length; i += 1) {
    if (elements.length >= maxElements) {
      truncated = true;
      break;
    }
    if (now() - startedAt > maxDurationMs) {
      truncated = true;
      break;
    }

    const element = candidates[i];
    if (!element) continue;

    const style = getStyle(element);
    if (!isElementVisible(element, style)) continue;

    const role = classifyElementRole(element);
    const ownText = hasOwnText(element);
    // A wrapper (e.g. `<p>`) whose entire visible text lives inside a
    // nested, independently-analyzed element (e.g. `<span>`) would
    // otherwise produce a near-duplicate conflict for the same text.
    if (!isAlwaysRelevantRole(role) && !ownText) continue;

    const resolution = resolveColors(element, getStyle, backgroundCache);
    if (!resolution) continue;

    const id = element.getAttribute(ELEMENT_ID_ATTRIBUTE) ?? nextElementId();
    element.setAttribute(ELEMENT_ID_ATTRIBUTE, id);

    elements.push({
      id,
      tagName: element.tagName.toLowerCase(),
      role,
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
    });
  }

  return { elements, truncated };
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
