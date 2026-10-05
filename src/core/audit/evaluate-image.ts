import { evidence } from './evidence';
import type { ImageAuditInput } from './inputs';
import type { AuditAdaptationStatus, AuditCandidate, AuditTargetInput } from './types';

/**
 * M8 evaluator. Ordinary photographs, logos, illustrations and decorative images are never
 * findings. Three things are:
 *
 * - CA-IMG-001: the image layer read a small functional single-color icon and found it hard to
 *   tell from its background under the profile (it recolored it, or found no safe recoloring).
 *   Needs `adaptImages` on: pixels are only ever read with the user's opt-in;
 * - CA-IMG-002: a bitmap that looks like a chart (manual review: its series are pixels);
 * - CA-IMG-003: a small image inside a control whose pixels cannot be read (cross-origin, no CORS):
 *   ColorAdapt cannot judge it (manual review).
 *
 * The page's own image is what is judged: the layer's generated replacement bitmap is never
 * the "source" (the controller reports the original source while one is shown).
 */

const CHART_KINDS: ReadonlySet<string> = new Set(['chart-raster']);

function review(
  ruleId: 'CA-IMG-002' | 'CA-IMG-003',
  target: AuditTargetInput,
  summary: string,
  items: AuditCandidate['evidence'],
  confidence: AuditCandidate['confidence'],
): AuditCandidate {
  return {
    ruleId,
    target,
    context: ruleId === 'CA-IMG-002' ? 'raster-chart' : 'unreadable',
    profile: null,
    confidence,
    assessment: 'manual-review',
    summary,
    evidence: items,
    factors: {
      functionalImpact: 'none',
      informationLoss: 'none',
      interactive: false,
      redundancy: 'unknown',
    },
    adaptation: 'unsupported',
    simulation: null,
    recommendation: { adaptation: 'unsupported' },
  };
}

export function evaluateImage(input: ImageAuditInput): AuditCandidate[] {
  const { target, kind, confidence, layer } = input;

  if (CHART_KINDS.has(kind) && (confidence === 'HIGH' || confidence === 'MEDIUM')) {
    return [
      review(
        'CA-IMG-002',
        target,
        'This bitmap looks like a chart; its series are pixels ColorAdapt cannot read or change.',
        [
          evidence.text('image.kind', 'inference', 'What the image looks like', kind),
          evidence.text('image.confidence', 'inference', 'Classification confidence', confidence),
        ],
        confidence === 'HIGH' ? 'HIGH' : 'MEDIUM',
      ),
    ];
  }

  if (layer && layer.action === 'pixel-adapted') {
    return [iconIssue(input, 'adapted')];
  }
  if (layer && layer.action === 'unsupported' && layer.reason === 'no-safe-candidate') {
    return [iconIssue(input, 'no-safe-candidate')];
  }

  const unreadable = layer ? layer.readability === 'tainted' : input.crossOrigin;
  if (unreadable && input.interactive && input.small) {
    return [
      review(
        'CA-IMG-003',
        target,
        'This control’s image comes from another origin without CORS permission, so its colors cannot be read.',
        [
          evidence.text(
            'image.readability',
            'observed-fact',
            'Pixel access',
            'blocked (cross-origin without CORS)',
          ),
          evidence.text(
            'image.context',
            'observed-fact',
            'Where it is',
            'inside a link or button, icon-sized',
          ),
        ],
        'MEDIUM',
      ),
    ];
  }
  return [];
}

function iconIssue(input: ImageAuditInput, status: AuditAdaptationStatus): AuditCandidate {
  return {
    ruleId: 'CA-IMG-001',
    target: input.target,
    context: 'monochrome-icon',
    profile: null,
    confidence: 'HIGH',
    assessment: 'issue',
    summary:
      'This functional icon’s single color is estimated to be hard to tell from its background under the audited profile.',
    evidence: [
      evidence.text(
        'image.kind',
        'inference',
        'What the image is',
        `${input.kind} (${input.confidence} confidence)`,
      ),
      evidence.text(
        'image.layer',
        'observed-fact',
        'What the image layer found',
        status === 'adapted' ? 'recolored it for the profile' : 'found no safe recoloring',
      ),
    ],
    factors: {
      functionalImpact: input.interactive ? 'major' : 'minor',
      informationLoss: 'partial',
      interactive: input.interactive,
      redundancy: 'unknown',
    },
    adaptation: status,
    simulation: null,
    recommendation: { adaptation: status },
  };
}
