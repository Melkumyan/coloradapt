import {
  CHART_LEGEND_ATTRIBUTE,
  CHART_MARK_ATTRIBUTE,
  CHART_NODE_ATTRIBUTE,
  CHART_OWNER_ATTRIBUTE,
  dashArrayFor,
  markerGlyph,
  patternSpec,
  pointShape,
  type ChartAdaptationPlan,
  type MarkerId,
  type PatternId,
  type SeriesPlan,
} from '@core/charts';
import { relativeLuminance, toHex } from '@core/color';
import type { ColorValue } from '@domain/models';
import type { ChartEnvironment } from './chart-facts';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A property the browser must report back for the chart to count as adapted. */
export interface Expectation {
  readonly element: Element;
  readonly property: 'stroke-dasharray' | 'marker-mid' | 'marker-start' | 'fill' | 'clip-path';
  /** A value (dash array) or a fragment (`#id`) the computed value must contain. */
  readonly expected: string;
}

export interface Artifacts {
  /** The one owned `<defs>` (markers and patterns), or null when none are needed. */
  readonly defs: Element | null;
  /** Overlay groups, each to be inserted right after its `anchor`. */
  readonly overlays: ReadonlyArray<{ readonly node: Element; readonly anchor: Element }>;
  /** Elements to tag, with the attribute that selects them. */
  readonly tagged: ReadonlyArray<{
    readonly element: Element;
    readonly attribute: string;
    readonly value: string;
  }>;
  readonly css: string;
  readonly expectations: readonly Expectation[];
  /** False when something the plan asks for could not be built (no box to place an overlay in): the chart must not be applied. */
  readonly complete: boolean;
  readonly counts: {
    readonly markers: number;
    readonly patterns: number;
    readonly overlays: number;
    readonly rules: number;
  };
}

export interface BuildContext {
  readonly doc: Document;
  readonly chartId: string;
  readonly env: ChartEnvironment;
  readonly svg: Element;
  /** Marks and texts by `order`. */
  readonly nodes: ReadonlyMap<number, Element>;
  /** Stable slot of a series within the chart (never reused while the chart lives). */
  readonly slotOf: (seriesId: string) => number;
  /** True when no element in the page has this id. */
  readonly idIsFree: (id: string) => boolean;
}

/** Black or white, whichever is read better on `color` (the crossover of WCAG contrast). */
export function inkFor(color: ColorValue): string {
  return relativeLuminance(color) > 0.179 ? '#111111' : '#ffffff';
}

function svgElement(doc: Document, name: string, attributes: Record<string, string> = {}): Element {
  const element = doc.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

function format(value: number): string {
  return String(Math.round(value * 100) / 100);
}

const LINE_MARK_TAGS = new Set(['path', 'polyline', 'line']);

class IdSource {
  #taken = new Set<string>();
  constructor(
    private readonly prefix: string,
    private readonly isFree: (id: string) => boolean,
  ) {}
  next(kind: string, slot: number): string {
    let id = `${this.prefix}-${kind}${slot}`;
    for (let n = 2; this.#taken.has(id) || !this.isFree(id); n += 1)
      id = `${this.prefix}-${kind}${slot}-${n}`;
    this.#taken.add(id);
    return id;
  }
}

/**
 * Turns a plan into the nodes, attributes and CSS that realize it. Builds only: nothing is
 * inserted. The caller inserts, then checks every {@link Expectation} against the browser and
 * undoes the lot if one fails.
 *
 * What it writes, and nothing else: one `<defs>` of `<marker>`/`<pattern>` with unique ids;
 * `data-coloradapt-chart-*` attributes on marks and legend swatches; one static CSS rule per
 * adapted series (`stroke-dasharray`, `marker-*`, `fill`); and, where a legend swatch is a box
 * (or a point needs a different shape), a decorative `pointer-events: none` overlay. Original
 * geometry, data and attributes are never edited.
 */
export function buildArtifacts(plan: ChartAdaptationPlan, ctx: BuildContext): Artifacts {
  const { doc, env, svg } = ctx;
  const ids = new IdSource(`coloradapt-${ctx.chartId}`, ctx.idIsFree);
  const defs = svgElement(doc, 'defs', {
    [CHART_NODE_ATTRIBUTE]: 'defs',
    [CHART_OWNER_ATTRIBUTE]: ctx.chartId,
  });
  const overlays: Array<{ node: Element; anchor: Element }> = [];
  const tagged: Array<{ element: Element; attribute: string; value: string }> = [];
  const expectations: Expectation[] = [];
  const rules: string[] = [];
  let markers = 0;
  let patterns = 0;
  let complete = true;

  const ownedNode = (
    name: string,
    role: string,
    attributes: Record<string, string> = {},
  ): Element =>
    svgElement(doc, name, {
      [CHART_NODE_ATTRIBUTE]: role,
      [CHART_OWNER_ATTRIBUTE]: ctx.chartId,
      'aria-hidden': 'true',
      focusable: 'false',
      ...attributes,
    });

  const markerNode = (id: string, marker: MarkerId, color: string, size: number): Element => {
    const glyph = markerGlyph(marker);
    const extent = size * 1.6;
    const node = svgElement(doc, 'marker', {
      id,
      markerUnits: 'userSpaceOnUse',
      markerWidth: format(extent * 2),
      markerHeight: format(extent * 2),
      viewBox: `${format(-extent)} ${format(-extent)} ${format(extent * 2)} ${format(extent * 2)}`,
      refX: '0',
      refY: '0',
      orient: '0',
      overflow: 'visible',
    });
    const path = svgElement(doc, 'path', { d: glyph.d, transform: `scale(${format(size)})` });
    if (glyph.paint === 'fill') {
      path.setAttribute('fill', color);
      path.setAttribute('stroke', 'none');
    } else {
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', color);
      path.setAttribute('stroke-width', '2');
      path.setAttribute('vector-effect', 'non-scaling-stroke');
    }
    node.append(path);
    markers += 1;
    return node;
  };

  const patternNode = (id: string, pattern: PatternId, base: ColorValue, unit: number): Element => {
    const spec = patternSpec(pattern);
    const size = spec.size * unit;
    const node = svgElement(doc, 'pattern', {
      id,
      patternUnits: 'userSpaceOnUse',
      width: format(size),
      height: format(size),
    });
    const content = svgElement(doc, 'g', { transform: `scale(${format(unit)})` });
    const ink = inkFor(base);
    content.append(
      svgElement(doc, 'rect', {
        width: String(spec.size),
        height: String(spec.size),
        fill: toHex(base),
      }),
    );
    for (const d of spec.strokes) {
      content.append(
        svgElement(doc, 'path', {
          d,
          fill: 'none',
          stroke: ink,
          'stroke-width': String(spec.strokeWidth),
        }),
      );
    }
    for (const dot of spec.dots) {
      content.append(
        svgElement(doc, 'circle', {
          cx: String(dot.cx),
          cy: String(dot.cy),
          r: String(dot.r),
          fill: ink,
        }),
      );
    }
    node.append(content);
    patterns += 1;
    return node;
  };

  for (const series of plan.series) {
    if (!series.changed) continue;
    const slot = ctx.slotOf(series.seriesId);
    const markValue = `${ctx.chartId}.${slot}`;
    const elements = series.marks
      .map((order) => ctx.nodes.get(order))
      .filter((element): element is Element => element !== undefined);
    const first = elements[0];
    if (!first) continue;
    const unit = env.unitsPerPixel(first);
    const color = toHex(series.color);

    switch (series.kind) {
      case 'line':
        buildLine(series, slot, markValue, elements, color, unit);
        break;
      case 'point':
        buildPoints(series, slot, markValue, elements, color, unit);
        break;
      default:
        buildFill(series, slot, markValue, elements, unit);
    }
  }

  function tag(element: Element, attribute: string, value: string): void {
    tagged.push({ element, attribute, value });
  }

  function legendElement(series: SeriesPlan): Element | null {
    return series.legendItem ? (ctx.nodes.get(series.legendItem.swatchOrder) ?? null) : null;
  }

  function buildLine(
    series: SeriesPlan,
    slot: number,
    markValue: string,
    elements: Element[],
    color: string,
    unit: number,
  ): void {
    const width = series.existing.strokeWidth;
    const dash = dashArrayFor(series.encoding.dash, width);
    const markerSize = Math.min(6, Math.max(3, width * 1.6)) * unit;
    const markerId = series.encoding.marker ? ids.next('m', slot) : null;
    if (markerId && series.encoding.marker)
      defs.append(markerNode(markerId, series.encoding.marker, color, markerSize));
    const decls = (dashText: string | null): string[] => [
      ...(dashText ? [`stroke-dasharray:${dashText.split(' ').join(',')} !important`] : []),
      ...(markerId
        ? [
            `marker-start:url(#${markerId}) !important`,
            `marker-mid:url(#${markerId}) !important`,
            `marker-end:url(#${markerId}) !important`,
          ]
        : []),
    ];
    const targets = elements.filter((element) =>
      LINE_MARK_TAGS.has(element.localName.toLowerCase()),
    );
    for (const element of targets) tag(element, CHART_MARK_ATTRIBUTE, markValue);
    rules.push(`[${CHART_MARK_ATTRIBUTE}="${markValue}"]{${decls(dash).join(';')}}`);
    const sample = targets[0];
    if (sample) {
      if (dash)
        expectations.push({ element: sample, property: 'stroke-dasharray', expected: dash });
      if (markerId)
        expectations.push({ element: sample, property: 'marker-mid', expected: `#${markerId}` });
    }

    const legend = legendElement(series);
    if (!legend || !series.legendItem) return;
    if (series.legendItem.kind === 'line') {
      // A line sample takes the series' own dashes and markers.
      const legendWidth = series.legendItem.strokeWidth;
      const legendDash = dashArrayFor(series.encoding.dash, legendWidth);
      tag(legend, CHART_LEGEND_ATTRIBUTE, markValue);
      const legendMarkerId = series.encoding.marker ? ids.next('lm', slot) : null;
      if (legendMarkerId && series.encoding.marker) {
        defs.append(
          markerNode(
            legendMarkerId,
            series.encoding.marker,
            color,
            Math.min(6, Math.max(3, legendWidth * 1.6)) * unit,
          ),
        );
      }
      const legendDecls = [
        ...(legendDash ? [`stroke-dasharray:${legendDash.split(' ').join(',')} !important`] : []),
        ...(legendMarkerId
          ? [
              `marker-start:url(#${legendMarkerId}) !important`,
              `marker-end:url(#${legendMarkerId}) !important`,
            ]
          : []),
      ];
      rules.push(`[${CHART_LEGEND_ATTRIBUTE}="${markValue}"]{${legendDecls.join(';')}}`);
      if (legendDash)
        expectations.push({ element: legend, property: 'stroke-dasharray', expected: legendDash });
      if (legendMarkerId)
        expectations.push({
          element: legend,
          property: 'marker-start',
          expected: `#${legendMarkerId}`,
        });
      return;
    }
    // A box or dot swatch cannot show a dash: draw a sample of the line over it, in the ink that reads on its color.
    const box = env.getLocalBox(legend);
    if (!box) {
      complete = false;
      return;
    }
    const ink = inkFor(series.color);
    const sampleWidth = Math.max(1.5, Math.min(3, box.h / 4)) * unit;
    const overlayDash = dashArrayFor(series.encoding.dash, sampleWidth);
    const overlayMarkerId = series.encoding.marker ? ids.next('om', slot) : null;
    if (overlayMarkerId && series.encoding.marker) {
      defs.append(
        markerNode(overlayMarkerId, series.encoding.marker, ink, Math.min(box.h / 3, 3.5 * unit)),
      );
    }
    const inset = Math.min(1.5, box.w / 8);
    const style = [
      overlayDash ? `stroke-dasharray:${overlayDash.split(' ').join(',')}` : '',
      overlayMarkerId
        ? `marker-start:url(#${overlayMarkerId});marker-end:url(#${overlayMarkerId})`
        : '',
    ]
      .filter(Boolean)
      .join(';');
    const group = ownedNode('g', 'overlay', { 'pointer-events': 'none' });
    const transform = legend.getAttribute('transform');
    if (transform) group.setAttribute('transform', transform);
    group.append(
      svgElement(doc, 'line', {
        x1: format(box.x + inset),
        y1: format(box.y + box.h / 2),
        x2: format(box.x + box.w - inset),
        y2: format(box.y + box.h / 2),
        stroke: ink,
        'stroke-width': format(sampleWidth),
        style,
      }),
    );
    overlays.push({ node: group, anchor: legend });
  }

  function buildPoints(
    series: SeriesPlan,
    slot: number,
    markValue: string,
    elements: Element[],
    color: string,
    unit: number,
  ): void {
    const marker = series.encoding.marker;
    const shape = marker ? pointShape(marker) : null;
    if (!shape) return;
    // The point itself is clipped (or hollowed): CSS on the point and on the legend dot, no node.
    for (const point of elements) tag(point, CHART_MARK_ATTRIBUTE, markValue);
    const legend = legendElement(series);
    if (legend) tag(legend, CHART_LEGEND_ATTRIBUTE, markValue);
    const decls = shape.hollow
      ? [
          'fill:none !important',
          `stroke:${color} !important`,
          `stroke-width:${format(1.6 * unit)} !important`,
        ]
      : [`clip-path:${shape.clip} !important`];
    rules.push(
      `[${CHART_MARK_ATTRIBUTE}="${markValue}"],[${CHART_LEGEND_ATTRIBUTE}="${markValue}"]{${decls.join(';')}}`,
    );
    const property = shape.hollow ? 'fill' : 'clip-path';
    const expected = shape.hollow ? 'none' : 'polygon';
    const sample = elements[0];
    if (sample) expectations.push({ element: sample, property, expected });
    if (legend) expectations.push({ element: legend, property, expected });
    void slot;
  }

  function buildFill(
    series: SeriesPlan,
    slot: number,
    markValue: string,
    elements: Element[],
    unit: number,
  ): void {
    const pattern = series.encoding.pattern;
    if (!pattern) return;
    const id = ids.next('p', slot);
    defs.append(patternNode(id, pattern, series.color, unit));
    for (const element of elements) tag(element, CHART_MARK_ATTRIBUTE, markValue);
    const legend = legendElement(series);
    if (legend) tag(legend, CHART_LEGEND_ATTRIBUTE, markValue);
    rules.push(
      `[${CHART_MARK_ATTRIBUTE}="${markValue}"],[${CHART_LEGEND_ATTRIBUTE}="${markValue}"]{fill:url(#${id}) !important}`,
    );
    const sample = elements[0];
    if (sample) expectations.push({ element: sample, property: 'fill', expected: `#${id}` });
    if (legend) expectations.push({ element: legend, property: 'fill', expected: `#${id}` });
  }

  void svg;
  return {
    defs: defs.childElementCount > 0 ? defs : null,
    overlays,
    tagged,
    css: rules.join('\n'),
    expectations,
    complete,
    counts: { markers, patterns, overlays: overlays.length, rules: rules.length },
  };
}
