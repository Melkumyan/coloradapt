import { collectOwnedIds, type AnalysisRoot } from '@core/analysis';
import { outermostSvg, resolveUseTarget } from '@core/svg';
import type { ClassifiedMutation, FullRescanReason, ResolvedBatch } from './types';

export interface ResolveOptions {
  readonly doc: Document;
  /** More distinct roots than this and the batch is one full rescan instead. */
  readonly maxRoots: number;
}

/** Whether `element` is live page content (connected and inside `<body>`). */
function isPageContent(element: Element, doc: Document): boolean {
  return element.isConnected && doc.body !== null && doc.body.contains(element);
}

/**
 * Collapses overlapping regions: a `subtree` root swallows its descendants
 * and any `self` root inside it, and wins over a `self` root on the same
 * element. Order of first appearance is kept. Cost is O(roots x depth).
 */
export function normalizeRoots(roots: readonly AnalysisRoot[]): AnalysisRoot[] {
  const byElement = new Map<Element, AnalysisRoot>();
  for (const root of roots) {
    const existing = byElement.get(root.element);
    if (!existing || (existing.scope === 'self' && root.scope === 'subtree')) {
      byElement.set(root.element, root);
    }
  }

  const subtreeElements = new Set<Element>();
  for (const root of byElement.values())
    if (root.scope === 'subtree') subtreeElements.add(root.element);

  const result: AnalysisRoot[] = [];
  for (const root of byElement.values()) {
    let covered = false;
    for (let ancestor = root.element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (subtreeElements.has(ancestor)) {
        covered = true;
        break;
      }
    }
    if (!covered) result.push(root);
  }
  return result;
}

/**
 * Inline SVGs that instantiate (`<use>`) something inside `unit`. When the
 * referenced content changes — a sprite loaded late, a symbol restyled — every
 * instance elsewhere on the page looks different, though nothing under *it*
 * mutated. Only units that define ids can be referenced, which keeps the common
 * icon (`<svg><use href="#x"/></svg>`) from costing a document-wide lookup.
 */
function dependentUnits(unit: Element, doc: Document): Element[] {
  if (!unit.querySelector('[id]')) return [];
  const dependents = new Set<Element>();
  for (const use of doc.querySelectorAll('use')) {
    const target = resolveUseTarget(use);
    if (target.kind !== 'local' || !unit.contains(target.target)) continue;
    const owner = outermostSvg(use);
    if (owner && owner !== unit) dependents.add(owner);
  }
  return [...dependents];
}

/**
 * Turns classified mutations into the regions to re-analyze and the elements
 * to forget (docs/DYNAMIC_ANALYSIS.md, "Affected-root resolution").
 *
 * - anything inside an inline SVG (an added/removed child, a class, `fill`, `href`
 *   or text change): the SVG itself, analyzed whole as one unit, plus the SVGs that
 *   `<use>` content defined in it;
 * - added element: its subtree;
 * - style-affecting attribute: the target's subtree, because a parent's
 *   background, opacity, color, visibility or CSS variable changes what its
 *   descendants resolve to (siblings and `:has()` are out of scope);
 * - text change: only that element (its own-text eligibility);
 * - removed element: nothing to analyze; if it really left the document its
 *   owned ids are collected for cleanup (a node that is connected again was
 *   moved, and shows up as an added root instead);
 * - stylesheet change, or a change to `<html>`/`<body>`: a full rescan, since
 *   no bounded region can be named.
 */
export function resolveAffectedRoots(
  mutations: readonly ClassifiedMutation[],
  options: ResolveOptions,
): ResolvedBatch {
  const { doc } = options;
  const candidates: AnalysisRoot[] = [];
  const removed: Element[] = [];
  let fullRescan: FullRescanReason | null = null;

  /** Queues the region for a change at `element`: an SVG unit if it is inside one. */
  const addRegion = (element: Element, scope: AnalysisRoot['scope']): void => {
    const unit = outermostSvg(element);
    if (!unit) {
      candidates.push({ element, scope });
      return;
    }
    // The unit's analysis covers its own descendants; only the SVG root itself can hold HTML (foreignObject).
    candidates.push({ element: unit, scope: element === unit ? scope : 'self' });
    for (const dependent of dependentUnits(unit, doc)) {
      candidates.push({ element: dependent, scope: 'self' });
    }
  };

  for (const mutation of mutations) {
    switch (mutation.kind) {
      case 'STYLESHEET_CHANGE':
        fullRescan ??= 'stylesheet';
        break;
      case 'NODE_ADDED':
      case 'STYLE_AFFECTING_ATTRIBUTE': {
        const { element } = mutation;
        if (element === doc.documentElement || element === doc.body) {
          fullRescan ??= 'document-root';
        } else if (isPageContent(element, doc)) {
          addRegion(element, 'subtree');
        }
        break;
      }
      case 'TEXT_CHANGE':
        if (isPageContent(mutation.element, doc)) addRegion(mutation.element, 'self');
        break;
      case 'NODE_REMOVED':
        if (!mutation.element.isConnected) {
          removed.push(mutation.element);
          // A child that left an inline SVG changes what the SVG paints.
          const { parent } = mutation;
          if (parent && isPageContent(parent, doc) && outermostSvg(parent))
            addRegion(parent, 'self');
        }
        break;
      default:
        break;
    }
  }

  if (fullRescan) return { roots: [], removed: [], fullRescan };

  const roots = normalizeRoots(candidates);
  if (roots.length > options.maxRoots) {
    return { roots: [], removed: [], fullRescan: 'too-many-roots' };
  }
  return { roots, removed, fullRescan: null };
}

/** Owned ids inside detached subtrees, each once. */
export function collectRemovedIds(removed: readonly Element[]): string[] {
  const ids = new Set<string>();
  for (const element of removed) for (const id of collectOwnedIds(element)) ids.add(id);
  return [...ids];
}
