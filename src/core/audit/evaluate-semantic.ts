import type { SemanticConfidence, SemanticEvidence, SemanticState } from '@core/semantics';
import { evidence } from './evidence';
import { redactSnippet, safeName } from './privacy';
import type { SemanticAuditInput } from './inputs';
import type {
  AuditAdaptationStatus,
  AuditCandidate,
  AuditConfidence,
  FunctionalImpact,
  InformationLoss,
} from './types';

/**
 * M6 evaluator: an element the semantic layer classified as carrying a state, that differs from
 * its peers in that state by paint alone.
 *
 * - high semantic confidence from *declared* semantics (aria-*, native validity, role) + a
 *   color-only verdict                              -> CA-SEM-001, an issue;
 * - any other color-only verdict (the state is guessed from class names, data tokens or words,
 *   however well corroborated)                      -> CA-SEM-002, manual review (ColorAdapt does
 *   not claim a defect on an inference);
 * - anything else (unknown, conflicting evidence, a cue or structural difference already there,
 *   nothing to compare with) -> nothing. `unknown` beats a wrong conclusion.
 */

const CONFIDENCE: Readonly<Record<SemanticConfidence, AuditConfidence>> = {
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
};

/** States whose loss stops a user from completing or understanding something. */
const CRITICAL_STATES: ReadonlySet<SemanticState> = new Set(['error', 'invalid', 'required']);
/** States of a control the user operates: which tab, which option, whether it can be used. */
const CONTROL_STATES: ReadonlySet<SemanticState> = new Set([
  'selected',
  'unselected',
  'active',
  'inactive',
  'disabled',
  'enabled',
]);
/** States that usually travel with a sign or an arrow in the text: color adds, rarely carries alone. */
const POLARITY_STATES: ReadonlySet<SemanticState> = new Set([
  'positive',
  'negative',
  'increase',
  'decrease',
]);

function factorsFor(state: SemanticState, interactive: boolean, field: boolean) {
  const informationLoss: InformationLoss = CRITICAL_STATES.has(state) ? 'total' : 'partial';
  let functionalImpact: FunctionalImpact = 'moderate';
  if (CRITICAL_STATES.has(state)) functionalImpact = interactive || field ? 'major' : 'moderate';
  else if (CONTROL_STATES.has(state)) functionalImpact = interactive ? 'major' : 'moderate';
  else if (POLARITY_STATES.has(state)) functionalImpact = 'minor';
  return {
    functionalImpact,
    informationLoss,
    interactive: interactive || field,
    redundancy: 'absent' as const,
  };
}

/** Sources whose matched value is a piece of the page's own text: quoted as a bounded, redacted snippet. */
const TEXT_SOURCES: ReadonlySet<SemanticEvidence['source']> = new Set([
  'text-token',
  'aria-label',
  'title-token',
  'aria-describedby',
]);

/**
 * What a signal may say of the page: `source: value (strength)`. Names and tokens pass `safeName`
 * (short, ordinary characters, nothing that looks like an identifier); a `data-*` signal keeps its
 * attribute name and a value only if the value is such a token; text goes through the snippet
 * redaction. Anything else is `[redacted]`, never copied.
 */
function signalValue(item: SemanticEvidence): string {
  if (TEXT_SOURCES.has(item.source)) return redactSnippet(item.value, 24) ?? '[redacted]';
  const raw = item.value.toLowerCase().replace(/\s+/g, '-');
  if (item.source === 'data-token') {
    const [name, ...rest] = raw.split('=');
    return `${safeName(name) ?? '?'}=${safeName(rest.join('=')) ?? '[redacted]'}`;
  }
  return safeName(raw) ?? '[redacted]';
}

function signals(items: readonly SemanticEvidence[]): string[] {
  return items.slice(0, 6).map((item) => `${item.source}: ${signalValue(item)} (${item.strength})`);
}

export function evaluateSemantic(input: SemanticAuditInput): AuditCandidate[] {
  const { result, verdict, target } = input;
  if (result.status !== 'classified' || verdict === null || !verdict.colorOnly) return [];

  // A defect is only claimed when the page itself *declares* the state (aria-*, native validity,
  // a live-region role: strong evidence). A state guessed from class names or words is an inference:
  // however well corroborated, it is reported for a human to check, never as a confirmed defect.
  const declared = result.evidence.some((item) => item.strength === 'strong');
  const confident = result.confidence === 'high' && declared;
  const state = result.state;
  const status: AuditAdaptationStatus = confident ? input.adaptation.status : 'not-applicable';
  return [
    {
      ruleId: confident ? 'CA-SEM-001' : 'CA-SEM-002',
      target,
      context: state,
      profile: null,
      confidence: declared
        ? CONFIDENCE[result.confidence]
        : result.confidence === 'low'
          ? 'LOW'
          : 'MEDIUM',
      assessment: confident ? 'issue' : 'manual-review',
      summary: confident
        ? `This element communicates “${state}” and differs from its peers in that state only by color.`
        : `This element may communicate “${state}” (${result.confidence} confidence) and differs from its peers only by color.`,
      evidence: [
        evidence.text('semantic.state', 'inference', 'State the element appears to carry', state),
        evidence.text(
          'semantic.confidence',
          'inference',
          'Confidence in that state',
          result.confidence,
        ),
        evidence.list(
          'semantic.signals',
          'inference',
          'Signals that point to the state',
          signals(result.evidence),
        ),
        evidence.text(
          'semantic.colorOnly',
          'observed-fact',
          'Why it is color-only',
          verdict.basis === 'peer-comparison'
            ? 'Compared with peers in another state, only paint differs (no icon, text, weight, border or size difference).'
            : 'An empty box: color is all it has to show anything with.',
        ),
      ],
      factors: factorsFor(state, input.interactive, input.field),
      adaptation: status,
      simulation: null,
      recommendation: { state, adaptation: status },
    },
  ];
}
