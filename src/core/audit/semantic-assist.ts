import { escapeHtml, hasUnsafeCharacters } from './privacy';

/**
 * How an AI-assisted interpretation is represented next to the audit (M11, docs/AI_SEMANTIC_ENGINE.md
 * and docs/AUDIT_EXPORT_SCHEMA.md). It is a separate section of a report, never a change to a finding:
 * the finding's evidence, severity, confidence and assessment are exactly what the deterministic
 * layers produced, and an interpretation can be removed from a report without altering any of them.
 *
 * The semantic engine (`core/semantic-ai`) produces these plain objects; this folder only holds
 * their shape, their export validation and their wording, so the audit never imports the engine.
 */

export const SEMANTIC_ASSIST_SCHEMA_VERSION = 1;

/** What the AI-assisted review did on this page: absence of an interpretation is not a clean bill. */
export const ASSIST_COVERAGE = [
  'disabled',
  'unavailable',
  'not-run',
  'partial',
  'completed',
] as const;
export type AssistCoverage = (typeof ASSIST_COVERAGE)[number];

export const ASSIST_MODEL_STATUSES = [
  'SUPPORTED_HYPOTHESIS',
  'AMBIGUOUS',
  'INSUFFICIENT_CONTEXT',
  'MODEL_ERROR',
] as const;
export const ASSIST_VALIDATOR_STATUSES = ['ACCEPTED_ADVISORY', 'REJECTED', 'UNRESOLVED'] as const;

export interface AssistEvidenceRef {
  readonly id: string;
  readonly source: string;
  readonly value: string;
}

export interface AuditSemanticAssistEntry {
  readonly findingId: string;
  readonly task: string;
  readonly modelStatus: (typeof ASSIST_MODEL_STATUSES)[number];
  readonly validatorStatus: (typeof ASSIST_VALIDATOR_STATUSES)[number];
  /** A stable machine reason (`accepted`, `insufficient-corroboration`, `timeout`, ...). */
  readonly validatorReason: string;
  /** The label the model proposed; `null` unless it proposed one. Shown as "likely meaning" only when accepted. */
  readonly hypothesis: string | null;
  /** The model's own number. Not a finding's confidence and not an authorization. */
  readonly modelConfidence: number | null;
  /** Ids the model cited, each one present in the packet. */
  readonly evidenceRefs: readonly string[];
  /** The deterministic evidence that supports the label, when the validator found some. */
  readonly supportingEvidence: readonly AssistEvidenceRef[];
  /** Hash of the sanitized packet: ties a result to its input without exporting the input. */
  readonly inputFingerprint: string;
  /**
   * Elements the finding covers. An interpretation is of the representative element; with more than
   * one, it was asked only because every sampled element gave the same packet.
   */
  readonly instances: number;
  /** Elements whose packets were compared (the representative included). */
  readonly sampled: number;
}

export interface AssistStats {
  readonly eligible: number;
  readonly queried: number;
  readonly deduped: number;
  readonly cacheHits: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly unresolved: number;
  readonly modelErrors: number;
  readonly timeouts: number;
  /** Cases left manual review because the run's budget was spent. */
  readonly notQueued: number;
}

export interface AuditSemanticAssistReport {
  readonly schemaVersion: typeof SEMANTIC_ASSIST_SCHEMA_VERSION;
  /** Always `true` when the section lists interpretations: the report says who made them. */
  readonly aiAssisted: boolean;
  readonly coverage: AssistCoverage;
  /** Provider type and model identifier as reported; not evidence of anything. */
  readonly provider: { readonly id: string; readonly model: string | null };
  /** `SEMANTIC_SCHEMA_VERSION` and the instruction version of the engine that ran. */
  readonly semanticSchemaVersion: number;
  readonly instructionVersion: number;
  /** Fixed sentence: an interpretation is advisory and never a finding. */
  readonly note: string;
  readonly stats: AssistStats;
  readonly entries: readonly AuditSemanticAssistEntry[];
}

export const ASSIST_NOTE =
  'AI-assisted interpretations are advisory. They were produced by a local model, checked against ' +
  'deterministic evidence and never change, add or remove a finding. Not a confirmed deterministic finding.';

/** The words of the UI and the HTML report, in one place. */
export const ASSIST_LABELS = {
  heading: 'AI-assisted interpretation',
  likelyMeaning: 'Likely meaning',
  needsReview: 'Needs review',
  local: 'Locally analyzed',
  localPrivacy:
    'Local AI · summaries go only to the model runtime on this computer; ColorAdapt sends nothing to external services',
  advisory: 'Not a confirmed deterministic finding',
} as const;

export const ASSIST_COVERAGE_LABEL: Readonly<Record<AssistCoverage, string>> = {
  disabled: '○ AI assist off',
  unavailable: '✕ Local AI unavailable',
  'not-run': '○ AI-assisted review not run',
  partial: '◐ Partly reviewed',
  completed: '● Reviewed',
};

export const ASSIST_STATUS_LABEL = {
  ACCEPTED_ADVISORY: '● Likely meaning (advisory)',
  REJECTED: '✕ Interpretation rejected',
  UNRESOLVED: '○ Needs review',
} as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const COUNT_KEYS: readonly (keyof AssistStats)[] = [
  'eligible',
  'queried',
  'deduped',
  'cacheHits',
  'accepted',
  'rejected',
  'unresolved',
  'modelErrors',
  'timeouts',
  'notQueued',
];

/**
 * Checks the `semanticAssist` section of a parsed report: shape, enumerations, bounds, and the
 * invariants that keep an interpretation advisory (an accepted entry has a label, a rejected or
 * unresolved one is never shown as a meaning, no raw model or prompt text can be present).
 */
export function checkSemanticAssist(value: unknown, findingIds: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  if (!isObject(value)) return ['semanticAssist is not an object'];
  const allowed = new Set([
    'schemaVersion',
    'aiAssisted',
    'coverage',
    'provider',
    'semanticSchemaVersion',
    'instructionVersion',
    'note',
    'stats',
    'entries',
  ]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) errors.push(`semanticAssist.${key}: field not in the schema`);
  if (value.schemaVersion !== SEMANTIC_ASSIST_SCHEMA_VERSION)
    errors.push('semanticAssist.schemaVersion unsupported');
  if (typeof value.aiAssisted !== 'boolean') errors.push('semanticAssist.aiAssisted invalid');
  if (!(ASSIST_COVERAGE as readonly unknown[]).includes(value.coverage))
    errors.push('semanticAssist.coverage invalid');
  if (
    !isObject(value.provider) ||
    typeof value.provider.id !== 'string' ||
    !['disabled', 'mock', 'local-http', 'local-ollama'].includes(value.provider.id) ||
    (value.provider.model !== null &&
      (typeof value.provider.model !== 'string' || value.provider.model.length > 60))
  ) {
    errors.push('semanticAssist.provider invalid');
  }
  if (!Number.isInteger(value.semanticSchemaVersion) || !Number.isInteger(value.instructionVersion))
    errors.push('semanticAssist versions invalid');
  if (typeof value.note !== 'string' || value.note === '')
    errors.push('semanticAssist.note missing');
  if (!isObject(value.stats)) errors.push('semanticAssist.stats missing');
  else {
    for (const key of COUNT_KEYS) {
      const count = value.stats[key];
      if (!Number.isInteger(count) || (count as number) < 0)
        errors.push(`semanticAssist.stats.${key} invalid`);
    }
  }
  if (!Array.isArray(value.entries)) {
    errors.push('semanticAssist.entries missing');
    return errors;
  }
  if (value.entries.length > 1000) errors.push('semanticAssist.entries too many');
  const seen = new Set<string>();
  (value.entries as unknown[]).forEach((entry, index) => {
    const where = `semanticAssist.entries[${index}]`;
    if (!isObject(entry)) {
      errors.push(`${where}: not an object`);
      return;
    }
    const keys = new Set([
      'findingId',
      'task',
      'modelStatus',
      'validatorStatus',
      'validatorReason',
      'hypothesis',
      'modelConfidence',
      'evidenceRefs',
      'supportingEvidence',
      'inputFingerprint',
      'instances',
      'sampled',
    ]);
    for (const key of Object.keys(entry))
      if (!keys.has(key)) errors.push(`${where}.${key}: field not in the schema`);
    if (typeof entry.findingId !== 'string' || !findingIds.has(entry.findingId))
      errors.push(`${where}: findingId does not name a finding of this report`);
    else if (seen.has(entry.findingId)) errors.push(`${where}: duplicate findingId`);
    else seen.add(entry.findingId);
    if (typeof entry.task !== 'string' || !/^[A-Z_]{8,40}$/.test(entry.task))
      errors.push(`${where}: task invalid`);
    if (!(ASSIST_MODEL_STATUSES as readonly unknown[]).includes(entry.modelStatus))
      errors.push(`${where}: modelStatus invalid`);
    if (!(ASSIST_VALIDATOR_STATUSES as readonly unknown[]).includes(entry.validatorStatus))
      errors.push(`${where}: validatorStatus invalid`);
    if (typeof entry.validatorReason !== 'string' || !/^[a-z-]{2,60}$/.test(entry.validatorReason))
      errors.push(`${where}: validatorReason invalid`);
    if (
      typeof entry.inputFingerprint !== 'string' ||
      !/^[0-9a-f]{16}$/.test(entry.inputFingerprint)
    )
      errors.push(`${where}: inputFingerprint invalid`);
    if (
      !Number.isInteger(entry.instances) ||
      !Number.isInteger(entry.sampled) ||
      (entry.sampled as number) < 1 ||
      (entry.instances as number) < (entry.sampled as number)
    )
      errors.push(`${where}: instances / sampled invalid`);
    const hasLabel =
      typeof entry.hypothesis === 'string' && /^[a-z-]{2,40}$/.test(entry.hypothesis);
    if (entry.hypothesis !== null && !hasLabel) errors.push(`${where}: hypothesis invalid`);
    if (entry.validatorStatus === 'ACCEPTED_ADVISORY' && !hasLabel)
      errors.push(`${where}: an accepted interpretation needs a label`);
    if (
      entry.validatorStatus === 'ACCEPTED_ADVISORY' &&
      entry.modelStatus !== 'SUPPORTED_HYPOTHESIS'
    )
      errors.push(`${where}: only a supported hypothesis can be accepted`);
    if (
      entry.modelConfidence !== null &&
      (typeof entry.modelConfidence !== 'number' ||
        !Number.isFinite(entry.modelConfidence) ||
        entry.modelConfidence < 0 ||
        entry.modelConfidence > 1)
    )
      errors.push(`${where}: modelConfidence out of range`);
    if (
      !Array.isArray(entry.evidenceRefs) ||
      entry.evidenceRefs.length > 8 ||
      !(entry.evidenceRefs as unknown[]).every(
        (ref) => typeof ref === 'string' && /^e[1-9]\d?$/.test(ref),
      )
    )
      errors.push(`${where}: evidenceRefs invalid`);
    if (!Array.isArray(entry.supportingEvidence) || entry.supportingEvidence.length > 20) {
      errors.push(`${where}: supportingEvidence invalid`);
    } else {
      for (const item of entry.supportingEvidence as unknown[]) {
        if (
          !isObject(item) ||
          typeof item.id !== 'string' ||
          typeof item.source !== 'string' ||
          typeof item.value !== 'string' ||
          item.value.length > 160 ||
          Object.keys(item).length !== 3
        )
          errors.push(`${where}: supportingEvidence entry invalid`);
      }
    }
  });
  const text = JSON.stringify(value);
  if (hasUnsafeCharacters(text)) errors.push('semanticAssist holds an unsafe character');
  return errors;
}

/** The HTML section of a report: kept apart from the deterministic findings and labelled as advisory. */
export function semanticAssistHtml(
  assist: AuditSemanticAssistReport,
  titles: ReadonlyMap<string, string>,
): string {
  const rows = assist.entries
    .map((entry) => {
      const meaning =
        entry.validatorStatus === 'ACCEPTED_ADVISORY' && entry.hypothesis
          ? `${escapeHtml(ASSIST_LABELS.likelyMeaning)}: <strong>${escapeHtml(entry.hypothesis)}</strong>` +
            (entry.modelConfidence !== null
              ? ` <span class="meta">(model confidence ${entry.modelConfidence.toFixed(2)}, not a finding confidence)</span>`
              : '')
          : escapeHtml(ASSIST_LABELS.needsReview);
      const support = entry.supportingEvidence
        .map(
          (item) =>
            `<code>${escapeHtml(item.id)}</code> ${escapeHtml(item.source)}: ${escapeHtml(item.value)}`,
        )
        .join('; ');
      const scope =
        entry.instances > 1
          ? `<br><span class="meta">Representative element: ${entry.sampled} of ${entry.instances} elements compared, identical evidence</span>`
          : '';
      return `<tr><td><a href="#${escapeHtml(entry.findingId)}">${escapeHtml(titles.get(entry.findingId) ?? entry.findingId)}</a>${scope}</td><td>${escapeHtml(ASSIST_STATUS_LABEL[entry.validatorStatus])}</td><td>${meaning}</td><td>${support === '' ? '—' : support}</td><td><code>${escapeHtml(entry.validatorReason)}</code></td></tr>`;
    })
    .join('');
  const s = assist.stats;
  return `<h2>${escapeHtml(ASSIST_LABELS.heading)}</h2>
<p><strong>${escapeHtml(ASSIST_COVERAGE_LABEL[assist.coverage])}.</strong> ${escapeHtml(ASSIST_LABELS.advisory)}. Provider: <code>${escapeHtml(assist.provider.id)}</code>${assist.provider.model ? ` · model <code>${escapeHtml(assist.provider.model)}</code>` : ''}${assist.provider.id.startsWith('local-') ? ` · ${escapeHtml(ASSIST_LABELS.local)}` : ''}.</p>
<p class="note">${escapeHtml(assist.note)} No interpretation here changes a finding above; a case without one is simply not interpreted, and says nothing about the page.</p>
<p class="note">${s.eligible} eligible · ${s.queried} sent to the model · ${s.accepted} accepted as advisory · ${s.rejected} rejected · ${s.unresolved} unresolved · ${s.modelErrors} model errors · ${s.notQueued} not queued (budget, or the elements of a finding differ).</p>
${assist.entries.length === 0 ? '' : `<table><thead><tr><th scope="col">Finding</th><th scope="col">Status</th><th scope="col">Interpretation</th><th scope="col">Supporting evidence</th><th scope="col">Validator</th></tr></thead><tbody>${rows}</tbody></table>`}`;
}
