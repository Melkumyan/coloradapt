import { CHART_LIMITS } from '@shared/constants';
import type { ChartFacts, LegendItem, MarkFacts, SwatchKind, TextFacts } from './types';
import { fillVisible, isStraight, paintKeyOf, strokeVisible } from './util';

export interface DetectedLegend {
  readonly items: readonly LegendItem[];
  /** Orders of swatch marks and label texts: never data. */
  readonly orders: ReadonlySet<number>;
}

/** Longest side of a box/point swatch. */
const MAX_SWATCH = 40;
/** A line sample: at least this long, at most this long. */
const LINE_SAMPLE_MIN = 8;
const LINE_SAMPLE_MAX = 90;
/** Swatches of one legend differ in size by at most this factor. */
const SIZE_TOLERANCE = 1.4;

function swatchKind(mark: MarkFacts): SwatchKind | null {
  const box = mark.box;
  if (!box) return null;
  if (isStraight(mark) && strokeVisible(mark) && !fillVisible(mark)) {
    const isLine = box.w >= LINE_SAMPLE_MIN && box.w <= LINE_SAMPLE_MAX && box.h <= 3;
    return isLine ? 'line' : null;
  }
  if (!fillVisible(mark) && !strokeVisible(mark)) return null;
  if (box.w < 3 || box.h < 3 || box.w > MAX_SWATCH || box.h > MAX_SWATCH) return null;
  return mark.tag === 'circle' || mark.tag === 'ellipse' ? 'point' : 'box';
}

function swatchPaintKey(mark: MarkFacts, kind: SwatchKind): string | null {
  if (kind === 'line') return paintKeyOf(mark.stroke);
  return paintKeyOf(mark.fill) ?? paintKeyOf(mark.stroke);
}

function swatchColor(mark: MarkFacts, kind: SwatchKind): LegendItem['color'] {
  if (kind === 'line') return mark.stroke.color;
  return mark.fill.kind === 'solid' ? mark.fill.color : mark.stroke.color;
}

function sameStructure(items: readonly LegendItem[]): boolean {
  const kind = items[0]?.kind;
  if (!items.every((item) => item.kind === kind)) return false;
  const widths = items.map((item) => item.box?.w ?? 0);
  const heights = items.map((item) => item.box?.h ?? 0);
  const similar = (values: readonly number[]) => {
    const low = Math.min(...values);
    const high = Math.max(...values);
    return low > 0 && high / low <= SIZE_TOLERANCE;
  };
  // A line sample's thickness is its stroke, not its box.
  return similar(widths) && (kind === 'line' || similar(heights));
}

/** What tells two legend swatches apart without reading their text. */
function swatchIdentity(item: LegendItem, mark: MarkFacts): string {
  return `${item.paintKey ?? '?'}|${mark.dash ?? ''}|${mark.markerRef ?? ''}`;
}

/**
 * Finds legend entries: a small swatch immediately followed (in document order, in the same
 * parent) by its text, repeated at least twice with swatches of one size and one kind that
 * show different paints. Nothing is guessed from position: ticks (one color, one dash), data
 * labels (many, same paint) and axis titles are not repeated swatch+text pairs of distinct paints.
 */
export function detectLegend(facts: ChartFacts): DetectedLegend {
  const marksByOrder = new Map<number, MarkFacts>();
  for (const mark of facts.marks) marksByOrder.set(mark.order, mark);
  const children = new Map<number, number>();
  for (const node of [...facts.marks, ...facts.texts]) {
    const parent = node.ancestry[0] ?? -1;
    children.set(parent, (children.get(parent) ?? 0) + 1);
  }

  interface Candidate {
    readonly item: LegendItem;
    readonly mark: MarkFacts;
    readonly text: TextFacts;
    readonly cluster: number;
  }
  const clusters = new Map<number, Candidate[]>();
  for (const text of facts.texts) {
    if (text.text.trim() === '') continue;
    const mark = marksByOrder.get(text.order - 1);
    if (!mark) continue;
    const parent = mark.ancestry[0] ?? -1;
    if (parent !== (text.ancestry[0] ?? -1)) continue;
    const kind = swatchKind(mark);
    if (!kind) continue;
    const item: LegendItem = {
      swatchOrder: mark.order,
      textOrder: text.order,
      kind,
      label: text.text.trim(),
      color: swatchColor(mark, kind),
      paintKey: swatchPaintKey(mark, kind),
      dataSeries: mark.dataSeries,
      classTokens: mark.classTokens,
      box: mark.box,
      strokeWidth: mark.strokeWidth,
    };
    // One pair per item group => the group is the cluster (D3 `<g class=item>`); a flat run
    // of pairs in one parent is the cluster itself.
    const cluster = (children.get(parent) ?? 0) === 2 ? (mark.ancestry[1] ?? -1) : parent;
    const list = clusters.get(cluster) ?? [];
    list.push({ item, mark, text, cluster });
    clusters.set(cluster, list);
  }

  const items: LegendItem[] = [];
  const orders = new Set<number>();
  for (const list of clusters.values()) {
    if (list.length < 2 || list.length > CHART_LIMITS.maxLegendItems) continue;
    if (!sameStructure(list.map((candidate) => candidate.item))) continue;
    const identities = new Set(
      list.map((candidate) => swatchIdentity(candidate.item, candidate.mark)),
    );
    if (identities.size !== list.length) continue;
    for (const candidate of list) {
      items.push(candidate.item);
      orders.add(candidate.item.swatchOrder);
      orders.add(candidate.item.textOrder);
    }
  }
  items.sort((a, b) => a.swatchOrder - b.swatchOrder);
  return { items, orders };
}
