import { CHART_NODE_ATTRIBUTE, pathStats, pointsCount } from '@core/charts';
import { outermostSvg } from '@core/svg';
import { CHART_LIMITS } from '@shared/constants';

/**
 * The chart layer's two signals M4 cannot give (docs/CHARTS.md, "Resize and geometry"):
 *
 *  - a chart's **size** changes without any mutation (a CSS breakpoint, a container resizing, a
 *    `display: none` panel becoming visible): hatch scale, marker size and layout-based direct labels
 *    are stale until something re-reads the chart;
 *  - a path's **`d`** (or a polyline's `points`) changes: the marker-density policy depends on its
 *    vertex count, and `d` is deliberately not an attribute M4 subscribes to for the whole page (an
 *    SVG animation writing `d` every frame would flood it).
 *
 * Both are *bounded* to the charts the layer asks for (`sync`): one `ResizeObserver` and one
 * `MutationObserver` for all of them, `attributeFilter: ['d', 'points']`, scoped to those charts only.
 * Neither observes the document. Both only *signal*: the pass itself is M4's (`invalidate`), so the
 * work is coalesced and budgeted like every other pass, and this class decides nothing about charts.
 *
 * Loop safety: nothing ColorAdapt writes changes a chart's rendered size or a `d`/`points`
 * attribute (overlays are `pointer-events: none` nodes inside the `<svg>`, patterns and markers are
 * in `<defs>`), and a record about our own node is dropped.
 *
 * A `d` change that leaves the path's structure alone (the same vertex count, arcs, closure) is not
 * signalled: it is a data update that moves points (a transition, a live refresh), which cannot
 * change what is written. Crossing the marker-density limit, or any change of vertex count, is.
 */

export interface WatchCounters {
  /** Subscriptions made (an `observe` of a chart that was not watched). */
  readonly subscribed: number;
  /** Size changes signalled. */
  readonly resizeSignals: number;
  /** Structural `d`/`points` changes signalled. */
  readonly geometrySignals: number;
}

function sizeOf(svg: Element): { w: number; h: number } {
  const rect = svg.getBoundingClientRect();
  return { w: Math.round(rect.width), h: Math.round(rect.height) };
}

/** What about a `d`/`points` value matters to the chart layer: the structure, not the coordinates. */
function structureOf(tag: string, attribute: string, value: string | null): string | null {
  if (value === null) return null;
  if (attribute === 'points') return `p${pointsCount(value)}`;
  if (tag !== 'path') return null;
  const stats = pathStats(value);
  return `${stats.vertices}|${stats.arcCount}|${stats.closed ? 1 : 0}|${stats.rectilinear ? 1 : 0}`;
}

export class ChartWatch {
  readonly #view: Window;
  readonly #signal: (svg: Element) => void;
  readonly #targets = new Set<Element>();
  readonly #sizes = new Map<Element, { w: number; h: number }>();
  #resize: ResizeObserver | null = null;
  #mutations: MutationObserver | null = null;
  #counters: WatchCounters = { subscribed: 0, resizeSignals: 0, geometrySignals: 0 };

  constructor(view: Window, signal: (svg: Element) => void) {
    this.#view = view;
    this.#signal = signal;
  }

  /** Charts watched right now. */
  get size(): number {
    return this.#targets.size;
  }

  get counters(): WatchCounters {
    return this.#counters;
  }

  /**
   * Makes `wanted` the watched set (at most `maxWatched`; the rest are not watched). Charts that
   * left the document or the set are released first, so a removed chart is never retained.
   */
  sync(wanted: Iterable<Element>): void {
    const desired = new Set<Element>();
    for (const svg of wanted) {
      if (desired.size >= CHART_LIMITS.maxWatched) break;
      if (svg.isConnected) desired.add(svg);
    }
    if (desired.size === 0) {
      this.disconnect();
      return;
    }
    let removed = false;
    for (const svg of this.#targets) {
      if (desired.has(svg)) continue;
      this.#resize?.unobserve(svg);
      this.#targets.delete(svg);
      this.#sizes.delete(svg);
      removed = true;
    }
    const added: Element[] = [];
    for (const svg of desired) if (!this.#targets.has(svg)) added.push(svg);
    if (added.length === 0 && !removed) return;

    this.#ensure();
    for (const svg of added) {
      this.#targets.add(svg);
      this.#sizes.set(svg, sizeOf(svg));
      this.#resize?.observe(svg);
      this.#counters = { ...this.#counters, subscribed: this.#counters.subscribed + 1 };
    }
    // A MutationObserver cannot drop one target: rebuild it when one was released.
    if (removed && this.#mutations) this.#mutations.disconnect();
    for (const svg of removed ? this.#targets : added) this.#observeGeometry(svg);
  }

  /** Releases every subscription. The next `sync` starts afresh. */
  disconnect(): void {
    this.#resize?.disconnect();
    this.#mutations?.disconnect();
    this.#resize = null;
    this.#mutations = null;
    this.#targets.clear();
    this.#sizes.clear();
  }

  #ensure(): void {
    const view = this.#view as Window & {
      ResizeObserver?: typeof ResizeObserver;
      MutationObserver?: typeof MutationObserver;
    };
    if (!this.#resize && view.ResizeObserver) {
      this.#resize = new view.ResizeObserver((entries) => this.#onResize(entries));
    }
    if (!this.#mutations && view.MutationObserver) {
      this.#mutations = new view.MutationObserver((records) => this.#onMutations(records));
    }
  }

  #observeGeometry(svg: Element): void {
    this.#mutations?.observe(svg, {
      subtree: true,
      attributes: true,
      attributeFilter: ['d', 'points'],
      attributeOldValue: true,
    });
  }

  #onResize(entries: readonly ResizeObserverEntry[]): void {
    const changed = new Set<Element>();
    for (const entry of entries) {
      const target = entry.target;
      const before = this.#sizes.get(target);
      if (!before) continue;
      const w = Math.round(entry.contentRect.width);
      const h = Math.round(entry.contentRect.height);
      // The first callback of an observation reports the size we already read.
      if (before.w === w && before.h === h) continue;
      this.#sizes.set(target, { w, h });
      changed.add(target);
    }
    for (const svg of changed) {
      this.#counters = { ...this.#counters, resizeSignals: this.#counters.resizeSignals + 1 };
      this.#signal(svg);
    }
  }

  #onMutations(records: readonly MutationRecord[]): void {
    // The value before the batch, per (element, attribute); the current one is read from the element.
    const first = new Map<Element, Map<string, string | null>>();
    for (const record of records) {
      const name = record.attributeName;
      if (record.type !== 'attributes' || !name || !(record.target instanceof Element)) continue;
      const seen = first.get(record.target) ?? new Map<string, string | null>();
      first.set(record.target, seen);
      if (!seen.has(name)) seen.set(name, record.oldValue);
    }
    const changed = new Set<Element>();
    for (const [target, attributes] of first) {
      if (target.closest(`[${CHART_NODE_ATTRIBUTE}]`)) continue;
      const svg = outermostSvg(target);
      if (!svg || !this.#targets.has(svg)) continue;
      const tag = target.localName.toLowerCase();
      for (const [name, before] of attributes) {
        const now = target.getAttribute(name);
        if (structureOf(tag, name, before) !== structureOf(tag, name, now)) changed.add(svg);
      }
    }
    for (const svg of changed) {
      this.#counters = { ...this.#counters, geometrySignals: this.#counters.geometrySignals + 1 };
      this.#signal(svg);
    }
  }
}
