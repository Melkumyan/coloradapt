import { getRule } from './rules';
import type {
  AuditAdaptationStatus,
  AuditRecommendation,
  AuditSuggestedColor,
  RecommendationContext,
} from './types';

/**
 * Recommendations are deterministic templates (docs/DEVELOPER_AUDIT.md, "Recommendations"): a
 * rule's own text, plus the values observed on the page, plus what ColorAdapt did. No generated
 * prose and no invented replacement colors: a color is suggested only when the adaptation engine
 * (M3) found and validated one, and is then labeled as ColorAdapt's own suggestion.
 */

const ADAPTATION_TEXT: Readonly<Record<AuditAdaptationStatus, string | null>> = {
  'not-applicable': null,
  'not-needed': 'ColorAdapt checked and made no change.',
  adapted:
    'ColorAdapt compensates on the page for the user. The source page is unchanged: fix it there.',
  'not-applied':
    'ColorAdapt planned a change but the browser did not render it, so the page is shown as authored.',
  'no-safe-candidate': 'ColorAdapt could not safely correct this automatically.',
  unsupported: 'ColorAdapt does not support this content and made no change.',
  'not-enabled': 'ColorAdapt adaptation is off: the page is shown as authored.',
};

const SUGGESTION_NOTE =
  'A ColorAdapt-generated suggestion (a color that fixes this pair for the audited profile). Not a standard or a design recommendation.';

/** Wording for a state that is ambiguous: no state-specific icon is prescribed. */
const GENERIC_STATE_ACTION =
  'Add a non-color indicator that changes with the state (an icon, text, underline or shape).';

export function buildRecommendation(
  ruleId: string,
  context: RecommendationContext,
): AuditRecommendation {
  const rule = getRule(ruleId);
  if (!rule) {
    return {
      summary: 'Review this element manually.',
      actions: [],
      observed: context.observed ?? null,
      coloradapt: ADAPTATION_TEXT[context.adaptation],
      suggestedColor: null,
    };
  }
  const actions = [...rule.recommendation.actions];
  if (
    ruleId === 'CA-SEM-001' &&
    context.state &&
    /^(?:required|invalid|error)$/.test(context.state)
  ) {
    // A field the user must fix: say so, without prescribing the glyph.
    actions.unshift(
      `Make the ${context.state} state visible without color: ${GENERIC_STATE_ACTION.toLowerCase()}`,
    );
  }
  let suggestedColor: AuditSuggestedColor | null = null;
  if (context.suggestedHex && /^#[0-9a-f]{6}$/i.test(context.suggestedHex)) {
    suggestedColor = {
      hex: context.suggestedHex.toLowerCase(),
      origin: 'coloradapt-generated',
      note: SUGGESTION_NOTE,
    };
  }
  return {
    summary: rule.recommendation.summary,
    actions,
    observed: context.observed ?? null,
    coloradapt: ADAPTATION_TEXT[context.adaptation],
    suggestedColor,
  };
}
