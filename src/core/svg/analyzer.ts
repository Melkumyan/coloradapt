import type {
  ColorValue,
  ElementDescriptor,
  SvgPaintTarget,
  SvgPartialReason,
  SvgUnitInfo,
  SvgUnsupportedReason,
} from '@domain/models';
import { parseColor } from '@core/color';
import {
  resolveEffectiveBackground,
  resolveEffectiveTextColor,
  type BackgroundResolutionCache,
} from '@core/analysis/background-resolution';
import { isElementVisible } from '@core/analysis/visibility';
import { SVG_BUDGET } from '@shared/constants';
import { clamp01 } from '@shared/utils';
import {
  PROBE_COLORS,
  buildColorProbeCss,
  buildProbeCss,
  derivationOf,
  type SvgStyleProbe,
} from './inheritance';
import {
  classifyPaintServer,
  parseNumber,
  parsePaint,
  withDerivation,
  type PaintDerivation,
  type PaintServerKind,
  type RawPaint,
  type SvgPaint,
} from './paint';
import { scanSvg, type PaintedElement, type ScannedUse, type StyleReader } from './scan';

/** Max per-channel difference (0-1) for "visible color == plain paint color". */
const COLOR_TOLERANCE = 1.5 / 255;

/** Reasons in the order they are reported when several apply. */
const REASON_PRIORITY: readonly SvgUnsupportedReason[] = [
  'chart-owned',
  'foreign-object',
  'embedded-image',
  'animated',
  'filter',
  'mask',
  'blend-mode',
  'marker',
  'paint-context',
  'paint-gradient',
  'paint-pattern',
  'paint-server',
  'use-external',
  'use-unresolved',
  'use-shared-paint',
  'complex-svg',
  'chart-like',
  'multi-paint',
];

export interface SvgAnalysisEnvironment {
  readonly getStyle: StyleReader;
  readonly backgroundCache: BackgroundResolutionCache;
  /** Gives an element its stable `data-coloradapt-id` (the analyzer's own registry). */
  readonly ensureId: (element: Element) => string;
  /**
   * Applies a style probe for one synchronous read (`inheritance.ts`). Without it
   * nothing can tell which declaration drives a paint, so no SVG is ever adapted.
   */
  readonly probe?: SvgStyleProbe;
  /** Elements a running animation drives a paint property on (CSS or Web Animations). */
  readonly animatedTargets?: ReadonlySet<Element>;
  /** The chart layer's answer to "is this SVG yours?" (M7); an owned SVG is never adapted here. */
  readonly isChartOwned?: (svg: Element) => boolean;
}

export interface SvgUnitResult {
  readonly element: Element;
  /** Null when the SVG is hidden or paints nothing: it is not a unit at all. */
  readonly descriptor: ElementDescriptor | null;
  /** Rule targets (and the SVG itself) by id, so callers need no document-wide lookup. */
  readonly nodes: ReadonlyMap<string, Element>;
}

interface SelfPaint {
  readonly via: 'self';
  /** The <svg> the paint belongs to. */
  readonly root: Element;
  readonly painted: PaintedElement;
  readonly property: 'fill' | 'stroke';
  readonly color: ColorValue;
  /** Paint opacity x the element's group opacity inside the SVG. */
  readonly opacity: number;
  derivation: PaintDerivation;
}

interface UsePaint {
  readonly via: 'use';
  readonly use: ScannedUse;
  readonly content: PaintedElement;
  readonly property: 'fill' | 'stroke';
  readonly hostFillOpacity: number;
  readonly hostStrokeOpacity: number;
  readonly hostStrokeWidth: number;
  derivation: PaintDerivation;
}

type PendingPaint = SelfPaint | UsePaint;

interface Draft {
  readonly root: Element;
  readonly rootStyle: CSSStyleDeclaration;
  readonly reasons: Set<SvgUnsupportedReason>;
  readonly pending: PendingPaint[];
  readonly hosts: Set<Element>;
  paintServer?: PaintServerKind;
  /** Something paints (even something unsupported): the SVG is a unit. */
  paints: boolean;
  scan: ReturnType<typeof scanSvg> | null;
}

function noteServer(draft: Draft, kind: PaintServerKind): void {
  draft.paintServer ??= kind;
  draft.reasons.add(
    kind === 'gradient' ? 'paint-gradient' : kind === 'pattern' ? 'paint-pattern' : 'paint-server',
  );
}

/** Registers what a non-solid paint means for the unit. Returns true if it was handled. */
function noteNonSolid(draft: Draft, paint: RawPaint, doc: Document): boolean {
  switch (paint.kind) {
    case 'none':
      return true;
    case 'paint-server':
      draft.paints = true;
      noteServer(draft, classifyPaintServer(doc, paint.reference));
      return true;
    case 'context':
      draft.paints = true;
      draft.reasons.add('paint-context');
      return true;
    case 'unsupported':
      draft.paints = true;
      draft.reasons.add('paint-server');
      return true;
    case 'solid':
      return false;
  }
}

/** The part of an element's paint that makes a property visible at all. */
function paintOpacity(painted: PaintedElement, property: 'fill' | 'stroke'): number {
  return property === 'fill' ? painted.fillOpacity : painted.strokeOpacity;
}

function visiblePropertyPaint(painted: PaintedElement, property: 'fill' | 'stroke'): string | null {
  if (property === 'fill') return painted.fillOpacity > 0 ? painted.fill : null;
  return painted.strokeOpacity > 0 && painted.strokeWidth > 0 ? painted.stroke : null;
}

function isAnimated(root: Element, targets: ReadonlySet<Element> | undefined): boolean {
  if (!targets || targets.size === 0) return false;
  for (const target of targets) if (root.contains(target) || target.contains(root)) return true;
  return false;
}

/** Phase 1: one bounded walk per SVG, using only the page's own styles. */
function draftUnit(root: Element, env: SvgAnalysisEnvironment): Draft | null {
  const rootStyle = env.getStyle(root);
  if (!isElementVisible(root, rootStyle)) return null;

  const draft: Draft = {
    root,
    rootStyle,
    reasons: new Set(),
    pending: [],
    hosts: new Set(),
    paints: false,
    scan: null,
  };
  const scan = scanSvg(root, env.getStyle);
  draft.scan = scan;
  for (const reason of scan.blockers) draft.reasons.add(reason);
  if (scan.overBudget) draft.reasons.add('complex-svg');
  if (isAnimated(root, env.animatedTargets)) draft.reasons.add('animated');

  const doc = root.ownerDocument;
  for (const painted of scan.painted) {
    for (const property of ['fill', 'stroke'] as const) {
      const value = visiblePropertyPaint(painted, property);
      if (value === null) continue;
      const paint = parsePaint(value);
      if (noteNonSolid(draft, paint, doc) || paint.kind !== 'solid') continue;
      draft.paints = true;
      draft.pending.push({
        via: 'self',
        root,
        painted,
        property,
        color: paint.color,
        opacity: paintOpacity(painted, property) * painted.groupOpacity,
        derivation: 'unknown',
      });
    }
  }

  for (const use of scan.uses) {
    draft.paints = true;
    if (use.target.kind !== 'local' || !use.host) continue;
    draft.hosts.add(use.host);
    const hostStyle = env.getStyle(use.host);
    const hostFillOpacity = parseNumber(hostStyle.fillOpacity, 1);
    const hostStrokeOpacity = parseNumber(hostStyle.strokeOpacity, 1);
    const hostStrokeWidth = parseNumber(hostStyle.strokeWidth, 1);
    for (const content of use.content) {
      for (const property of ['fill', 'stroke'] as const) {
        draft.pending.push({
          via: 'use',
          use,
          content,
          property,
          hostFillOpacity,
          hostStrokeOpacity,
          hostStrokeWidth,
          derivation: 'unknown',
        });
      }
    }
  }
  return draft;
}

/** Phase 2: one probe for every SVG of the batch, one style flush in and one out. */
function probeDrafts(drafts: readonly Draft[], env: SvgAnalysisEnvironment): void {
  if (!env.probe) return;
  const probed = drafts.filter((draft) => draft.pending.length > 0 && draft.reasons.size === 0);
  if (probed.length === 0) return;

  const targets = new Set<Element>();
  for (const draft of probed) {
    targets.add(draft.root);
    for (const host of draft.hosts) targets.add(host);
  }
  const ids = [...targets].map((element) => env.ensureId(element));
  env.probe(buildProbeCss(ids), () => {
    for (const draft of probed) {
      for (const paint of draft.pending) {
        const element = paint.via === 'self' ? paint.painted.element : paint.content.element;
        paint.derivation = derivationOf(paint.property, env.getStyle(element)[paint.property]);
      }
    }
  });

  // A paint that inherits `fill`/`stroke` may still be `currentColor`'s: the element it inherits
  // from (the <svg>, or a <use>) can itself paint with `currentColor`. A second probe replaces only
  // `color` there: an inherited paint that then reads the sentinel follows `color`.
  const inherited = probed.flatMap((draft) =>
    draft.pending.filter((paint) => paint.derivation === 'inherited'),
  );
  if (inherited.length === 0) return;
  const colorTargets = new Set<Element>();
  for (const paint of inherited) {
    colorTargets.add(paint.via === 'self' ? paint.root : paint.use.use);
  }
  const colorIds = [...colorTargets].map((element) => env.ensureId(element));
  env.probe(buildColorProbeCss(colorIds), () => {
    for (const paint of inherited) {
      const element = paint.via === 'self' ? paint.painted.element : paint.use.use;
      if (env.getStyle(element)[paint.property] === PROBE_COLORS.color) {
        paint.derivation = 'currentColor';
      }
    }
  });
}

interface ResolvedPaint {
  /** The paint: `currentColor` (owned by `color`) or a plain `solid` one (owned by fill/stroke). */
  readonly paint: SvgPaint;
  readonly color: ColorValue;
  /** Alpha folded in from paint opacity, color alpha and group opacity. */
  readonly alpha: number;
  readonly target: { readonly element: Element; readonly property: SvgPaintTarget['property'] };
}

/** Resolves one paint of a `<use>` instance from the `<use>` element's own computed style. */
function resolveUsePaint(
  draft: Draft,
  paint: UsePaint,
  env: SvgAnalysisEnvironment,
): ResolvedPaint | null {
  const { use, content, property } = paint;
  const useStyle = env.getStyle(use.use);
  const declaredOpacity = paintOpacity(content, property);
  const inheritedOpacity = property === 'fill' ? paint.hostFillOpacity : paint.hostStrokeOpacity;
  const instanceOpacity = property === 'fill' ? useStyle.fillOpacity : useStyle.strokeOpacity;
  const opacity =
    declaredOpacity === inheritedOpacity ? parseNumber(instanceOpacity, 1) : declaredOpacity;
  const groupOpacity = use.groupOpacity * content.groupOpacity;
  if (opacity <= 0) return null;

  if (paint.derivation === 'explicit') {
    // The referenced content declares this paint itself: every instance shares it.
    const value = visiblePropertyPaint(content, property);
    if (value === null) return null;
    const raw = parsePaint(value);
    if (noteNonSolid(draft, raw, content.element.ownerDocument)) return null;
    draft.reasons.add('use-shared-paint');
    return null;
  }
  if (paint.derivation === 'unknown') return null;

  if (paint.derivation === 'currentColor') {
    const color = parseColor(useStyle.color);
    if (!color || color.alpha <= 0) return null;
    return {
      paint: { kind: 'currentColor', color },
      color,
      alpha: color.alpha * opacity * groupOpacity,
      target: { element: use.use, property: 'color' },
    };
  }

  // Inherited: the instance paints with the `<use>` element's own `fill`/`stroke`.
  if (property === 'stroke') {
    const declaredWidth = content.strokeWidth;
    const width =
      declaredWidth === paint.hostStrokeWidth
        ? parseNumber(useStyle.strokeWidth, 1)
        : declaredWidth;
    if (width <= 0) return null;
  }
  const raw = parsePaint(property === 'fill' ? useStyle.fill : useStyle.stroke);
  if (noteNonSolid(draft, raw, use.use.ownerDocument) || raw.kind !== 'solid') return null;
  return {
    paint: raw,
    color: raw.color,
    alpha: raw.color.alpha * opacity * groupOpacity,
    target: { element: use.use, property },
  };
}

function resolveSelfPaint(draft: Draft, paint: SelfPaint): ResolvedPaint | null {
  if (paint.derivation === 'unknown') return null;
  const alpha = paint.color.alpha * paint.opacity;
  const svgPaint = withDerivation({ kind: 'solid', color: paint.color }, paint.derivation);
  const base = { paint: svgPaint, color: paint.color, alpha };
  // `currentColor` is `color`'s; a paint inherited from the <svg> is the <svg>'s own fill/stroke;
  // anything else is declared where it is painted.
  if (svgPaint.kind === 'currentColor') {
    return { ...base, target: { element: draft.root, property: 'color' } };
  }
  if (paint.derivation === 'inherited') {
    return { ...base, target: { element: draft.root, property: paint.property } };
  }
  return { ...base, target: { element: paint.painted.element, property: paint.property } };
}

function colorKey(color: ColorValue): string {
  const byte = (channel: number) => Math.round(clamp01(channel) * 255);
  return `${byte(color.r)},${byte(color.g)},${byte(color.b)}`;
}

function differs(a: ColorValue, b: ColorValue): boolean {
  return (
    Math.abs(a.r - b.r) > COLOR_TOLERANCE ||
    Math.abs(a.g - b.g) > COLOR_TOLERANCE ||
    Math.abs(a.b - b.b) > COLOR_TOLERANCE
  );
}

function firstReason(reasons: ReadonlySet<SvgUnsupportedReason>): SvgUnsupportedReason | undefined {
  return REASON_PRIORITY.find((reason) => reasons.has(reason));
}

/** Phase 3: turns what was read into one descriptor. */
function finishUnit(draft: Draft, env: SvgAnalysisEnvironment): SvgUnitResult {
  const { root } = draft;
  const scan = draft.scan;
  const nodes = new Map<string, Element>();
  const resolved: ResolvedPaint[] = [];
  let partialReason: SvgPartialReason | undefined;

  if (draft.reasons.size === 0 && draft.pending.some((paint) => paint.derivation === 'unknown')) {
    partialReason = 'derivation-unknown';
  }
  for (const paint of draft.pending) {
    const result =
      paint.via === 'self' ? resolveSelfPaint(draft, paint) : resolveUsePaint(draft, paint, env);
    if (result) resolved.push(result);
  }
  // Paint of referenced content that was dropped (zero opacity, none) leaves `resolved` shorter; fine.

  const useCount = scan?.uses.length ?? 0;
  let textCount = 0;
  let plainShapes = 0;
  for (const painted of scan?.painted ?? []) {
    if (painted.kind === 'text') textCount += 1;
    else plainShapes += 1;
  }
  const shapeCount = plainShapes + useCount;

  // Nothing paints: not a unit. (A walk the budget cut short says nothing about what paints.)
  if (!draft.paints && resolved.length === 0 && !scan?.overBudget) {
    return { element: root, descriptor: null, nodes };
  }

  // Effective (composited) color of every paint, and whether it equals the plain paint color.
  const distinct = new Map<string, ColorValue>();
  let translucent = false;
  let foreground: ColorValue | null = null;
  for (const paint of resolved) {
    const rgb = { r: paint.color.r, g: paint.color.g, b: paint.color.b };
    const alpha = clamp01(paint.alpha);
    const effective = resolveEffectiveTextColor(
      root,
      { ...rgb, alpha },
      env.getStyle,
      env.backgroundCache,
    );
    const plain = resolveEffectiveTextColor(
      root,
      { ...rgb, alpha: 1 },
      env.getStyle,
      env.backgroundCache,
    );
    if (alpha < 0.999 || differs(plain, { ...rgb, alpha: 1 })) translucent = true;
    distinct.set(colorKey(effective), effective);
    foreground ??= effective;
  }
  const paintCount = distinct.size;

  const reasons = new Set(draft.reasons);
  if (env.isChartOwned?.(root)) reasons.add('chart-owned');
  if (
    paintCount >= 2 &&
    textCount >= SVG_BUDGET.chartLikeMinTextElements &&
    shapeCount >= SVG_BUDGET.chartLikeMinShapes
  ) {
    reasons.add('chart-like');
  }
  if (paintCount > SVG_BUDGET.maxDistinctPaints) reasons.add('complex-svg');
  else if (paintCount >= 2) reasons.add('multi-paint');
  const unsupportedReason = firstReason(reasons);

  const background = resolveEffectiveBackground(root, env.getStyle, env.backgroundCache);
  if (!foreground) {
    const own = parseColor(draft.rootStyle.color) ?? { r: 0, g: 0, b: 0, alpha: 1 };
    foreground = resolveEffectiveTextColor(root, own, env.getStyle, env.backgroundCache);
  }

  if (!unsupportedReason && !partialReason && translucent) partialReason = 'translucent-paint';

  const adaptable = !unsupportedReason && !partialReason && paintCount === 1;
  const targets: SvgPaintTarget[] = [];
  if (adaptable) {
    const seen = new Set<string>();
    for (const paint of resolved) {
      const elementId = env.ensureId(paint.target.element);
      const key = `${elementId}|${paint.target.property}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ elementId, property: paint.target.property });
      nodes.set(elementId, paint.target.element);
    }
  }

  const id = env.ensureId(root);
  nodes.set(id, root);
  const info: SvgUnitInfo = {
    kind: textCount > 0 && shapeCount === 0 ? 'text' : 'icon',
    ...(unsupportedReason ? { unsupportedReason } : {}),
    ...(partialReason ? { partialReason } : {}),
    paintCount,
    shapeCount,
    textCount,
    useCount,
    ...(draft.paintServer ? { paintServer: draft.paintServer } : {}),
    targets,
  };

  const backgroundSolid = background.kind === 'solid';
  const analysisStatus =
    unsupportedReason || !backgroundSolid
      ? 'unsupported'
      : partialReason || background.truncated || background.approximate || scan?.overBudget
        ? 'partial'
        : 'resolved';

  return {
    element: root,
    descriptor: {
      id,
      tagName: 'svg',
      role: info.kind === 'text' ? 'text' : 'icon',
      colorPair: { foreground, background: background.color },
      backgroundKind: background.kind,
      analysisStatus,
      isVisible: true,
      hasTextContent: textCount > 0,
      svg: info,
    },
    nodes,
  };
}

/**
 * Analyzes outermost inline SVGs as units (docs/SVG_ANALYSIS.md): one bounded
 * walk each, one shared style probe for the batch, one descriptor per SVG.
 * A unit is adaptable only when it is a *single visible paint*; everything
 * else is classified and left alone.
 */
export function analyzeSvgUnits(
  roots: readonly Element[],
  env: SvgAnalysisEnvironment,
): SvgUnitResult[] {
  const drafts: Draft[] = [];
  const results: Array<Draft | Element> = [];
  for (const root of roots) {
    const draft = draftUnit(root, env);
    if (draft) {
      drafts.push(draft);
      results.push(draft);
    } else {
      results.push(root);
    }
  }
  probeDrafts(drafts, env);
  return results.map((entry) =>
    'rootStyle' in entry
      ? finishUnit(entry, env)
      : { element: entry, descriptor: null, nodes: new Map() },
  );
}
