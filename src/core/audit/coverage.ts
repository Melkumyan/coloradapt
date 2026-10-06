import { AUDIT_LIMITS, type AuditCoverageLevel, type AuditSubsystemCoverage } from './types';

/**
 * Snapshot-level coverage: what an audit pass did and did not look at. A global limit (a budget, a
 * disabled setting, an unsupported area) is said once, here, instead of as one "analysis
 * limitation" per element. The wording is fixed and says what was not looked at, so a clean result
 * is never read as a statement about it.
 */

export const AUDIT_SUBSYSTEM_IDS = [
  'color-contrast',
  'semantic-cues',
  'svg',
  'charts',
  'image-pixels',
  'findings',
  'shadow-dom',
  'iframes',
  'borders-focus',
] as const;
export type AuditSubsystemId = (typeof AUDIT_SUBSYSTEM_IDS)[number];

export interface CoverageFacts {
  readonly analysisTruncated: boolean;
  readonly elementsAnalyzed: number;
  readonly budgetsReached: readonly string[];
  /** The image layer is reading pixels: adaptation is on and “Adapt functional images” is on. */
  readonly imagePixelAudit: boolean;
  readonly truncatedFindings: number;
}

function entry(
  id: AuditSubsystemId,
  name: string,
  level: AuditCoverageLevel,
  note: string,
): AuditSubsystemCoverage {
  return { id, name, level, note };
}

export function buildSubsystemCoverage(facts: CoverageFacts): AuditSubsystemCoverage[] {
  const reached = new Set(facts.budgetsReached);
  return [
    facts.analysisTruncated
      ? entry(
          'color-contrast',
          'Text and color analysis (M1–M3)',
          'partial',
          `Audit truncated: stopped at the size budget after ${facts.elementsAnalyzed} elements; the rest of the page was not audited.`,
        )
      : entry(
          'color-contrast',
          'Text and color analysis (M1–M3)',
          'complete',
          'Text that is painted was analyzed, up to the budget: every element that holds text of its own, plus links, buttons and form controls. Text that is not rendered (display: none and similar) is not judged. Text over a gradient or an image is listed as not analyzed, not judged.',
        ),
    reached.has('semantic candidates')
      ? entry(
          'semantic-cues',
          'Color-only state (M6)',
          'partial',
          'Audit truncated: the candidate budget ended the pass, so some elements were not checked.',
        )
      : entry(
          'semantic-cues',
          'Color-only state (M6)',
          'complete',
          'Elements that declare a state were compared with their peers; states guessed from class names are listed for review.',
        ),
    entry(
      'svg',
      'Inline SVG (M5)',
      'partial',
      'Only SVG with one effective paint is judged; any other inline SVG is listed for manual review.',
    ),
    reached.has('chart marks')
      ? entry(
          'charts',
          'Charts (M7)',
          'partial',
          'Audit truncated: a chart exceeded the mark budget and was listed for review instead of audited.',
        )
      : entry(
          'charts',
          'Charts (M7)',
          'partial',
          'Only SVG charts with a readable structure are audited; canvas and bitmap charts are listed for manual review.',
        ),
    facts.imagePixelAudit
      ? entry(
          'image-pixels',
          'Image pixels (M8)',
          'partial',
          reached.has('images')
            ? 'Audit truncated: the image budget ended the pass. Only small single-color functional icons are read; cross-origin images are listed for review.'
            : 'Only small single-color functional icons are read; photos and logos are never judged and cross-origin images are listed for review.',
        )
      : entry(
          'image-pixels',
          'Image pixels (M8)',
          'disabled',
          'Limited: image adaptation is disabled, so no pixel was read and icon colors were not checked. Having no image finding says nothing about the images.',
        ),
    facts.truncatedFindings > 0
      ? entry(
          'findings',
          'Finding list',
          'partial',
          `Audit truncated: ${facts.truncatedFindings} lower-ranked finding group(s) are counted in the summary but not listed (limit ${AUDIT_LIMITS.maxFindings}).`,
        )
      : entry('findings', 'Finding list', 'complete', 'Every finding group found is listed.'),
    entry('shadow-dom', 'Shadow DOM', 'unsupported', 'Content inside shadow roots is not audited.'),
    entry('iframes', 'Frames', 'unsupported', 'Content inside iframes is not audited.'),
    entry(
      'borders-focus',
      'Borders and focus indicators',
      'unsupported',
      'Borders, outlines and focus indicators are not audited.',
    ),
  ];
}
