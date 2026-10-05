import type {
  AuditAssessment,
  AuditCategory,
  AuditSeverity,
  AuditSource,
  AuditSubcategory,
  WcagRelation,
} from './types';

/**
 * The rule registry: the one place that says what each audit rule is called, where it comes
 * from, how severe it is by default and what to do about it. Rule ids are stable: they change
 * only when a rule's meaning changes (then it gets a new id and the old one is retired, never reused).
 * docs/AUDIT_RULES.md documents every entry; `tests/core/audit/rules.test.ts` checks that it does.
 */
export interface AuditRule {
  readonly id: string;
  readonly title: string;
  readonly category: AuditCategory;
  readonly subcategory: AuditSubcategory;
  readonly defaultSeverity: AuditSeverity;
  /** What the rule produces by default; a candidate may only downgrade it (never to or from `issue` by chance). */
  readonly assessment: AuditAssessment;
  readonly description: string;
  /** What a finding of this rule means, one sentence. */
  readonly summary: string;
  /** The recommendation template (docs/DEVELOPER_AUDIT.md, "Recommendations"). */
  readonly recommendation: { readonly summary: string; readonly actions: readonly string[] };
  readonly source: AuditSource;
  /** Criteria the rule is *related to*. Never a claim of conformance or failure. */
  readonly wcag: readonly WcagRelation[];
  /** The finding depends on a color vision simulation (profile + model confidence apply). */
  readonly simulationBased: boolean;
}

const related = (criterion: string, name: string): WcagRelation => ({
  criterion,
  name,
  relation: 'related-to',
});

const USE_OF_COLOR = related('1.4.1', 'Use of Color');
const CONTRAST_MINIMUM = related('1.4.3', 'Contrast (Minimum)');
const NON_TEXT_CONTRAST = related('1.4.11', 'Non-text Contrast');

export const AUDIT_RULES = {
  'CA-COLOR-001': {
    id: 'CA-COLOR-001',
    title: 'Text contrast below the engineering target',
    category: 'color-contrast',
    subcategory: 'text-contrast',
    defaultSeverity: 'medium',
    assessment: 'issue',
    description:
      'Visible text whose color and fully resolved solid background give a contrast ratio below ColorAdapt’s target (4.5:1, or 3:1 for large text).',
    summary: 'Text color and its background are too close in luminance.',
    recommendation: {
      summary: 'Increase the foreground/background contrast.',
      actions: [
        'Choose a text color and background that reach at least the contrast target shown in the evidence.',
        'Check the color in every state the element has (hover, focus, disabled, selected).',
      ],
    },
    source: { primary: 'M1', contributing: ['M3'], subsystem: 'CSS analysis' },
    wcag: [CONTRAST_MINIMUM],
    simulationBased: false,
  },
  'CA-COLOR-002': {
    id: 'CA-COLOR-002',
    title: 'Foreground and background hard to tell apart under a simulated profile',
    category: 'color-distinguishability',
    subcategory: 'foreground-background-conflict',
    defaultSeverity: 'medium',
    assessment: 'issue',
    description:
      'A foreground/background pair that is distinguishable in normal vision but whose simulated colors fall below the distinguishability threshold for the audited color vision profile.',
    summary:
      'The pair stays apart for normal vision but is estimated to merge under the simulated profile.',
    recommendation: {
      summary: 'Do not rely on hue difference alone between text and its background.',
      actions: [
        'Add a luminance difference between foreground and background.',
        'Where the color carries meaning, add a text label, icon, underline or shape.',
      ],
    },
    source: { primary: 'M2', contributing: ['M1', 'M3'], subsystem: 'Color vision simulation' },
    wcag: [],
    simulationBased: true,
  },
  'CA-COLOR-003': {
    id: 'CA-COLOR-003',
    title: 'Background could not be resolved',
    category: 'unsupported-content',
    subcategory: 'analysis-incomplete',
    defaultSeverity: 'info',
    assessment: 'analysis-limitation',
    description:
      'Text over a gradient, an image, a deep ancestor chain or another background ColorAdapt cannot reduce to one solid color. No contrast conclusion is drawn.',
    summary:
      'ColorAdapt cannot tell what color this text sits on, so it did not judge its contrast.',
    recommendation: {
      summary: 'Check this text manually against the lightest and darkest parts of its background.',
      actions: [
        'Measure the contrast against the worst-case region of the gradient or image.',
        'Consider a solid or semi-opaque backing behind text that sits over images.',
      ],
    },
    source: { primary: 'M1', contributing: [], subsystem: 'CSS analysis' },
    wcag: [],
    simulationBased: false,
  },
  'CA-GEN-001': {
    id: 'CA-GEN-001',
    title: 'Analysis stopped at a size budget',
    category: 'unsupported-content',
    subcategory: 'coverage-limited',
    defaultSeverity: 'info',
    assessment: 'analysis-limitation',
    description:
      'The page has more candidate elements than one audit pass analyzes. Elements beyond the budget were not audited.',
    summary: 'Part of this page was not audited.',
    recommendation: {
      summary: 'Audit the page in parts, or narrow it to the region of interest.',
      actions: [
        'Scroll or filter the page so that the region under review is smaller, then refresh the audit.',
      ],
    },
    source: { primary: 'M1', contributing: ['M4'], subsystem: 'CSS analysis' },
    wcag: [],
    simulationBased: false,
  },
  'CA-SEM-001': {
    id: 'CA-SEM-001',
    title: 'State communicated by color only',
    category: 'color-only-information',
    subcategory: 'missing-non-color-cue',
    defaultSeverity: 'medium',
    assessment: 'issue',
    description:
      'An element the page itself declares to carry a state (aria-invalid, aria-selected, aria-current, aria-pressed, native validity, a live-region role, ...), classified with high confidence, and that differs from its peers in that state by paint alone: no icon, text, shape, weight, border or other structural difference.',
    summary: 'The state of this element is shown by color alone.',
    recommendation: {
      summary: 'Do not use color as the only indicator of this state.',
      actions: [
        'Add an icon, a text label, an underline, a border style or a shape difference that also changes with the state.',
        'Expose the state to assistive technology (aria-invalid, aria-selected, aria-current, ...) if it is not already.',
      ],
    },
    source: { primary: 'M6', contributing: ['M3'], subsystem: 'Semantic cues' },
    wcag: [USE_OF_COLOR],
    simulationBased: false,
  },
  'CA-SEM-002': {
    id: 'CA-SEM-002',
    title: 'Possible color-only state: needs review',
    category: 'semantic-state',
    subcategory: 'ambiguous-semantic-color',
    defaultSeverity: 'low',
    assessment: 'manual-review',
    description:
      'An element looks color-only against its peers, but what its state is rests on an inference (class names, data attributes, words, even well corroborated) and not on anything the page declares, so ColorAdapt does not call it a defect.',
    summary:
      'This element may show a state by color alone; ColorAdapt is not sure what the state is.',
    recommendation: {
      summary: 'Check whether this element shows a state by color alone.',
      actions: [
        'If it does, add a non-color indicator (icon, text, underline, shape).',
        'If the state is only implied by a class name, expose it with a real attribute such as aria-invalid or aria-selected.',
      ],
    },
    source: { primary: 'M6', contributing: [], subsystem: 'Semantic cues' },
    wcag: [USE_OF_COLOR],
    simulationBased: false,
  },
  'CA-SVG-001': {
    id: 'CA-SVG-001',
    title: 'Inline SVG paint hard to see against its background',
    category: 'svg',
    subcategory: 'icon-conflict',
    defaultSeverity: 'medium',
    assessment: 'issue',
    description:
      'An inline SVG with a single effective paint whose contrast with its solid background is below 3:1, or whose simulated color is hard to tell from the background for the audited profile.',
    summary:
      'The SVG’s one paint color is close to its background in luminance or, under simulation, in color.',
    recommendation: {
      summary: 'Increase the contrast between this icon and its background.',
      actions: [
        'Choose an icon color that reaches at least 3:1 against its background.',
        'Where the icon color carries meaning, pair it with a text label or a shape change.',
      ],
    },
    source: { primary: 'M5', contributing: ['M1', 'M2', 'M3'], subsystem: 'SVG analysis' },
    wcag: [NON_TEXT_CONTRAST],
    simulationBased: true,
  },
  'CA-SVG-002': {
    id: 'CA-SVG-002',
    title: 'Inline SVG cannot be analyzed automatically',
    category: 'svg',
    subcategory: 'analysis-incomplete',
    defaultSeverity: 'info',
    assessment: 'manual-review',
    description:
      'An inline SVG that is not hidden from assistive technology uses paint ColorAdapt does not model (several paints, gradients, patterns, shared <use> paint, filters, animation, ...). No conclusion is drawn about it.',
    summary: 'ColorAdapt does not analyze this SVG’s colors.',
    recommendation: {
      summary: 'Review this SVG manually if its colors carry meaning.',
      actions: [
        'Check that different colors in the graphic are also told apart by shape, label or pattern.',
        'Mark purely decorative SVGs with aria-hidden="true".',
      ],
    },
    source: { primary: 'M5', contributing: [], subsystem: 'SVG analysis' },
    wcag: [],
    simulationBased: false,
  },
  'CA-CHART-001': {
    id: 'CA-CHART-001',
    title: 'Chart series told apart by color alone',
    category: 'chart',
    subcategory: 'series-color-conflict',
    defaultSeverity: 'medium',
    assessment: 'issue',
    description:
      'Two series of a chart ColorAdapt recognizes with high confidence have colors that are hard to tell apart under the audited profile, and nothing else in the chart (dash, marker, pattern, direct label) tells them apart.',
    summary: 'At least two series differ only by a color that merges under simulation.',
    recommendation: {
      summary: 'Give each series a distinct non-color encoding and mirror it in the legend.',
      actions: [
        'Use different dash styles or markers for lines, and patterns for bars and slices.',
        'Label series directly on the chart, or reflect the encoding in the legend swatch.',
      ],
    },
    source: { primary: 'M7', contributing: ['M2'], subsystem: 'Charts' },
    wcag: [USE_OF_COLOR],
    simulationBased: true,
  },
  'CA-CHART-002': {
    id: 'CA-CHART-002',
    title: 'Chart legend cannot be paired with its series',
    category: 'chart',
    subcategory: 'legend-ambiguous',
    defaultSeverity: 'low',
    assessment: 'manual-review',
    description:
      'A chart has a legend that cannot be matched one-to-one with its series (shared colors, missing entries), or sits outside the SVG as HTML. Series identity then rests on color and an unverified legend.',
    summary: 'ColorAdapt cannot verify which legend entry belongs to which series.',
    recommendation: {
      summary: 'Make the series-to-legend mapping explicit.',
      actions: [
        'Give each series a unique key (data-series, a title or aria-label) that the legend repeats.',
        'Reflect any non-color encoding of a series in its legend entry.',
      ],
    },
    source: { primary: 'M7', contributing: [], subsystem: 'Charts' },
    wcag: [USE_OF_COLOR],
    simulationBased: false,
  },
  'CA-CHART-003': {
    id: 'CA-CHART-003',
    title: 'Chart type not audited automatically',
    category: 'chart',
    subcategory: 'unsupported-chart',
    defaultSeverity: 'info',
    assessment: 'manual-review',
    description:
      'A chart whose structure ColorAdapt does not audit (heatmaps and sequential palettes, gradient fills, animated or filtered charts, charts over the size limits).',
    summary: 'ColorAdapt does not audit this kind of chart.',
    recommendation: {
      summary: 'Review this chart manually under a color vision simulator.',
      actions: [
        'Check that no meaning depends on telling two similar hues apart.',
        'For sequential data, make sure lightness (not only hue) carries the order.',
      ],
    },
    source: { primary: 'M7', contributing: [], subsystem: 'Charts' },
    wcag: [USE_OF_COLOR],
    simulationBased: false,
  },
  'CA-CHART-004': {
    id: 'CA-CHART-004',
    title: 'Canvas chart detected: manual review required',
    category: 'chart',
    subcategory: 'unsupported-canvas-chart',
    defaultSeverity: 'info',
    assessment: 'manual-review',
    description:
      'A <canvas> whose name, class or neighbors say it is a chart. A canvas is a bitmap with no structure to read, so ColorAdapt cannot audit its series.',
    summary: 'A canvas chart has no structure ColorAdapt can read.',
    recommendation: {
      summary: 'Review this chart manually; consider a non-color encoding for its series.',
      actions: [
        'Use different line styles, markers or patterns for series, and a text alternative for the data.',
        'Check the chart under a color vision simulator.',
      ],
    },
    source: { primary: 'M7', contributing: [], subsystem: 'Charts' },
    wcag: [USE_OF_COLOR],
    simulationBased: false,
  },
  'CA-IMG-001': {
    id: 'CA-IMG-001',
    title: 'Functional raster icon hard to tell from its background',
    category: 'image',
    subcategory: 'icon-conflict',
    defaultSeverity: 'medium',
    assessment: 'issue',
    description:
      'A small single-color bitmap icon, classified with high confidence as functional, whose pixels were read by the image layer and found hard to tell from its solid background under the profile. Needs “Adapt functional images” (pixel reading is opt-in).',
    summary: 'The icon’s one color merges with its background under simulation.',
    recommendation: {
      summary: 'Use an icon color with more contrast against its background.',
      actions: [
        'Provide the icon as an SVG or as a bitmap with a higher-contrast color.',
        'Pair the icon with a visible text label.',
      ],
    },
    source: { primary: 'M8', contributing: ['M2', 'M3'], subsystem: 'Image adaptation' },
    wcag: [NON_TEXT_CONTRAST],
    simulationBased: true,
  },
  'CA-IMG-002': {
    id: 'CA-IMG-002',
    title: 'Raster chart detected: manual review required',
    category: 'image',
    subcategory: 'unsupported-raster-chart',
    defaultSeverity: 'info',
    assessment: 'manual-review',
    description:
      'A bitmap that looks like a chart (a chart word in its name, or the structure of one). Its series are pixels, so ColorAdapt never changes it and cannot audit it.',
    summary: 'A bitmap chart has no structure ColorAdapt can read.',
    recommendation: {
      summary: 'Review this chart manually; offer the data as text or as an SVG chart.',
      actions: [
        'Check the chart under a color vision simulator.',
        'Describe the data in text, and use direct labels or patterns instead of color alone.',
      ],
    },
    source: { primary: 'M8', contributing: [], subsystem: 'Image adaptation' },
    wcag: [USE_OF_COLOR],
    simulationBased: false,
  },
  'CA-IMG-003': {
    id: 'CA-IMG-003',
    title: 'Functional image could not be read',
    category: 'image',
    subcategory: 'unreadable-image',
    defaultSeverity: 'info',
    assessment: 'manual-review',
    description:
      'A small image inside a link or button comes from another origin without CORS permission, so its pixels cannot be read. ColorAdapt cannot judge whether its color carries meaning.',
    summary: 'ColorAdapt cannot read this control’s image.',
    recommendation: {
      summary: 'Review this image manually if its color carries meaning.',
      actions: [
        'Serve the image with CORS headers and a crossorigin attribute, or inline it as SVG.',
        'Give the control a visible text label.',
      ],
    },
    source: { primary: 'M8', contributing: [], subsystem: 'Image adaptation' },
    wcag: [],
    simulationBased: false,
  },
} as const satisfies Record<string, AuditRule>;

export type AuditRuleId = keyof typeof AUDIT_RULES;

export const AUDIT_RULE_IDS = Object.keys(AUDIT_RULES) as AuditRuleId[];

export function getRule(ruleId: string): AuditRule | null {
  return (AUDIT_RULES as Readonly<Record<string, AuditRule>>)[ruleId] ?? null;
}
