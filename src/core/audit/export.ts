import { VISION_PROFILES, type VisionProfile } from '@domain/models';
import { AUDIT_SUBSYSTEM_IDS } from './coverage';
import { compareFindings } from './grouping';
import { AUDIT_RULES } from './rules';
import { escapeHtml, hasUnsafeCharacters, stripUnsafeCharacters } from './privacy';
import { summarize } from './snapshot';
import {
  checkSemanticAssist,
  semanticAssistHtml,
  type AuditSemanticAssistReport,
} from './semantic-assist';
import {
  ADAPTATION_LABEL,
  ASSESSMENT_LABEL,
  assessmentCountsLine,
  BASIS_LABEL,
  CATEGORY_LABEL,
  CONFIDENCE_LABEL,
  COVERAGE_LEVEL_LABEL,
  MODEL_CONFIDENCE_LABEL,
  SEVERITY_GLYPH,
  SEVERITY_LABEL,
} from './labels';
import {
  AUDIT_ADAPTATION_STATUSES,
  AUDIT_ASSESSMENTS,
  AUDIT_CATEGORIES,
  AUDIT_CONFIDENCES,
  AUDIT_COVERAGE_LEVELS,
  AUDIT_LIMITS,
  AUDIT_SCHEMA_VERSION,
  AUDIT_SEVERITIES,
  EVIDENCE_BASES,
  LOCATOR_LIMITS,
  type AuditCoverage,
  type AuditEvidence,
  type AuditFinding,
  type AuditPageInfo,
  type AuditSnapshot,
  type AuditSummary,
  type AuditValue,
} from './types';

/**
 * The exported report (docs/AUDIT_EXPORT_SCHEMA.md). It is a documented, versioned format of its
 * own, not a dump of internal objects, and it is deterministic: the same page state gives the
 * same bytes apart from `generatedAt` (keys sorted, findings, elements and profiles in a fixed
 * order). Nothing in it comes from outside the snapshot, which is already free of form values,
 * query strings and fragments (core/audit/privacy.ts).
 */
export interface AuditReport {
  readonly schemaVersion: typeof AUDIT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly tool: { readonly name: 'ColorAdapt'; readonly version: string };
  readonly page: AuditPageInfo;
  readonly audit: {
    /** The report describes the page as authored, not as ColorAdapt shows it. */
    readonly basis: 'original-page-state';
    readonly visionProfile: VisionProfile;
    readonly auditedProfiles: readonly VisionProfile[];
    readonly adaptationEnabled: boolean;
  };
  readonly summary: AuditSummary;
  readonly coverage: AuditCoverage;
  readonly findings: readonly AuditFinding[];
  /**
   * AI-assisted interpretations (M11), a section of their own: present only when the audit page
   * says what the AI-assisted review did. Findings never depend on it.
   */
  readonly semanticAssist?: AuditSemanticAssistReport;
}

/** Defense in depth: a string that reached the snapshot with an invisible character leaves it without one. */
function cleanStrings<T>(value: T): T {
  if (typeof value === 'string') return stripUnsafeCharacters(value) as T;
  if (Array.isArray(value)) return value.map(cleanStrings) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, cleanStrings(v)]),
    ) as T;
  }
  return value;
}

export function createAuditReport(
  snapshot: AuditSnapshot,
  generatedAt: number,
  semanticAssist?: AuditSemanticAssistReport,
): AuditReport {
  return cleanStrings(buildReport(snapshot, generatedAt, semanticAssist));
}

function buildReport(
  snapshot: AuditSnapshot,
  generatedAt: number,
  semanticAssist?: AuditSemanticAssistReport,
): AuditReport {
  const findings = [...snapshot.findings].sort(compareFindings);
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    generatedAt: new Date(generatedAt).toISOString(),
    tool: { name: 'ColorAdapt', version: snapshot.extensionVersion },
    page: snapshot.page,
    audit: {
      basis: 'original-page-state',
      visionProfile: snapshot.settings.activeProfile,
      auditedProfiles: snapshot.settings.auditedProfiles,
      adaptationEnabled: snapshot.settings.adaptationEnabled,
    },
    summary: summarize(findings),
    coverage: snapshot.coverage,
    findings,
    ...(semanticAssist ? { semanticAssist } : {}),
  };
}

/** JSON with every object's keys sorted: byte-identical for identical input. */
export function canonicalJson(value: unknown, space = 2): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, sort(v)]),
      );
    }
    return input;
  };
  return JSON.stringify(sort(value), null, space);
}

export function serializeAuditReport(report: AuditReport): string {
  return `${canonicalJson(report)}\n`;
}

// ---------------------------------------------------------------------------------------
// Validation (no import feature: this checks that a report is well-formed and consistent)
// ---------------------------------------------------------------------------------------

export type ParsedAuditReport =
  | { readonly ok: true; readonly report: AuditReport }
  | { readonly ok: false; readonly errors: readonly string[] };

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

const FORM_TAGS = new Set(['input', 'textarea', 'select']);

function checkEvidence(item: unknown, where: string, errors: string[]): void {
  if (!isObject(item)) {
    errors.push(`${where}: evidence is not an object`);
    return;
  }
  if (typeof item.key !== 'string' || item.key === '')
    errors.push(`${where}: evidence key missing`);
  if (!oneOf(EVIDENCE_BASES, item.basis)) errors.push(`${where}: evidence basis invalid`);
  if (typeof item.label !== 'string') errors.push(`${where}: evidence label missing`);
  const value = item.value;
  if (!isObject(value) || typeof value.kind !== 'string') {
    errors.push(`${where}: evidence value invalid`);
    return;
  }
  const kinds = ['color', 'colors', 'number', 'text', 'list'];
  if (!kinds.includes(value.kind)) errors.push(`${where}: evidence value kind invalid`);
}

function checkFinding(finding: unknown, index: number, ids: Set<string>, errors: string[]): void {
  const where = `findings[${index}]`;
  if (!isObject(finding)) {
    errors.push(`${where}: not an object`);
    return;
  }
  if (typeof finding.id !== 'string' || !/^CA-[A-Z]+-\d{3}:[0-9a-f]{16}$/.test(finding.id)) {
    errors.push(`${where}: id malformed`);
  } else if (ids.has(finding.id)) errors.push(`${where}: duplicate id ${finding.id}`);
  else ids.add(finding.id);

  const rule =
    typeof finding.ruleId === 'string'
      ? (AUDIT_RULES as Record<string, (typeof AUDIT_RULES)[keyof typeof AUDIT_RULES]>)[
          finding.ruleId
        ]
      : undefined;
  if (!rule) errors.push(`${where}: unknown ruleId`);
  else if (finding.category !== rule.category)
    errors.push(`${where}: category does not match its rule`);
  if (!oneOf(AUDIT_CATEGORIES, finding.category)) errors.push(`${where}: category invalid`);
  if (!oneOf(AUDIT_SEVERITIES, finding.severity)) errors.push(`${where}: severity invalid`);
  if (!oneOf(AUDIT_CONFIDENCES, finding.confidence)) errors.push(`${where}: confidence invalid`);
  if (!oneOf(AUDIT_ASSESSMENTS, finding.assessment)) errors.push(`${where}: assessment invalid`);
  if (!oneOf(AUDIT_ADAPTATION_STATUSES, finding.adaptationStatus))
    errors.push(`${where}: adaptationStatus invalid`);
  for (const field of ['title', 'summary', 'sourceNote']) {
    if (typeof finding[field] !== 'string' || finding[field] === '')
      errors.push(`${where}: ${field} missing`);
  }
  if (!Number.isInteger(finding.affectedCount) || (finding.affectedCount as number) < 1) {
    errors.push(`${where}: affectedCount invalid`);
  }
  const affected = Array.isArray(finding.affected) ? (finding.affected as unknown[]) : null;
  if (!affected) errors.push(`${where}: affected missing`);
  else {
    if (affected.length > AUDIT_LIMITS.sampleTargets)
      errors.push(`${where}: too many affected elements listed`);
    if (typeof finding.affectedCount === 'number' && affected.length > finding.affectedCount) {
      errors.push(`${where}: lists more elements than affectedCount`);
    }
    if (
      typeof finding.affectedCount === 'number' &&
      finding.affectedCount <= AUDIT_LIMITS.sampleTargets &&
      affected.length !== finding.affectedCount
    ) {
      errors.push(`${where}: affected does not list every element of a small finding`);
    }
    affected.forEach((entry, at) => {
      const spot = `${where}.affected[${at}]`;
      if (!isObject(entry) || !isObject(entry.locator)) {
        errors.push(`${spot}: invalid`);
        return;
      }
      const locator = entry.locator;
      if (typeof entry.instanceId !== 'string') errors.push(`${spot}: instanceId missing`);
      if (typeof locator.tag !== 'string') errors.push(`${spot}: locator.tag missing`);
      if (typeof locator.tag === 'string' && FORM_TAGS.has(locator.tag) && locator.text !== null) {
        errors.push(`${spot}: a form control must not carry text`);
      }
      if (typeof locator.text === 'string' && locator.text.length > LOCATOR_LIMITS.textLength)
        errors.push(`${spot}: text too long`);
      if (
        typeof locator.path !== 'string' ||
        locator.path.length > LOCATOR_PATH_MAX ||
        !Array.isArray(locator.classes) ||
        locator.classes.length > LOCATOR_LIMITS.classes ||
        !(locator.classes as unknown[]).every(
          (c) => typeof c === 'string' && c.length <= LOCATOR_LIMITS.tokenLength,
        ) ||
        (locator.id !== null &&
          (typeof locator.id !== 'string' || locator.id.length > LOCATOR_LIMITS.tokenLength))
      ) {
        errors.push(`${spot}: locator exceeds its bounds`);
      }
      if (!Array.isArray(entry.evidence)) errors.push(`${spot}: evidence missing`);
      else (entry.evidence as unknown[]).forEach((item) => checkEvidence(item, spot, errors));
    });
  }
  if (!Array.isArray(finding.evidence)) errors.push(`${where}: evidence missing`);
  else {
    const keys = new Set<string>();
    for (const item of finding.evidence as unknown[]) {
      checkEvidence(item, where, errors);
      if (isObject(item) && typeof item.key === 'string') {
        if (keys.has(item.key)) errors.push(`${where}: duplicate evidence key ${item.key}`);
        keys.add(item.key);
      }
    }
  }
  if (!isObject(finding.recommendation) || typeof finding.recommendation.summary !== 'string') {
    errors.push(`${where}: recommendation missing`);
  }
  if (!isObject(finding.source) || typeof finding.source.primary !== 'string')
    errors.push(`${where}: source missing`);
  if (
    !Array.isArray(finding.visionProfiles) ||
    !(finding.visionProfiles as unknown[]).every((p) => oneOf(VISION_PROFILES, p))
  ) {
    errors.push(`${where}: visionProfiles invalid`);
  }
  if (!Array.isArray(finding.simulation)) errors.push(`${where}: simulation missing`);
  if (
    !Array.isArray(finding.wcag) ||
    !(finding.wcag as unknown[]).every(
      (w) =>
        isObject(w) &&
        w.relation === 'related-to' &&
        typeof w.criterion === 'string' &&
        /^\d\.\d{1,2}\.\d{1,2}$/.test(w.criterion) &&
        typeof w.name === 'string',
    )
  ) {
    errors.push(`${where}: wcag may only list criteria the finding is related to`);
  }
}

/** A locator path is `tag>tag>...` of at most pathSegments segments, each short. */
const LOCATOR_PATH_MAX = 400;

/**
 * Parses and validates an exported report: structure, enumerations, privacy invariants (no query
 * or fragment, no text on form controls), and that `summary` equals what the findings add up to.
 */
export function parseAuditReport(text: string): ParsedAuditReport {
  const errors: string[] = [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['not valid JSON'] };
  }
  if (!isObject(data)) return { ok: false, errors: ['report is not an object'] };
  if (data.schemaVersion !== AUDIT_SCHEMA_VERSION) {
    errors.push(`unsupported schemaVersion ${String(data.schemaVersion)}`);
  }
  if (typeof data.generatedAt !== 'string' || Number.isNaN(Date.parse(data.generatedAt))) {
    errors.push('generatedAt is not a date');
  }
  if (
    !isObject(data.tool) ||
    data.tool.name !== 'ColorAdapt' ||
    typeof data.tool.version !== 'string'
  ) {
    errors.push('tool is invalid');
  }
  if (
    !isObject(data.page) ||
    typeof data.page.origin !== 'string' ||
    typeof data.page.pathname !== 'string'
  ) {
    errors.push('page is invalid');
  } else {
    if (!data.page.pathname.startsWith('/')) errors.push('page.pathname must start with /');
    if (/[?#]/.test(data.page.pathname) || /[?#]/.test(data.page.origin)) {
      errors.push('page must not contain a query or fragment');
    }
    // `origin` is exactly what `new URL(...).origin` gives (no credentials) or the opaque `null`;
    // the path may not carry credentials or an address-like segment (the redaction replaced those).
    if (data.page.origin !== 'null' && !/^https?:\/\/[^\s/@?#\\]+$/.test(data.page.origin)) {
      errors.push('page.origin is not a plain web origin');
    }
    if (/[@\s\\]/.test(data.page.pathname) || data.page.pathname.length > 2048) {
      errors.push('page.pathname holds characters a redacted path never has');
    }
  }
  collectUnsafeStrings(data, '', errors);
  if (!isObject(data.audit) || data.audit.basis !== 'original-page-state')
    errors.push('audit.basis is invalid');
  else {
    if (!oneOf(VISION_PROFILES, data.audit.visionProfile))
      errors.push('audit.visionProfile invalid');
    if (!Array.isArray(data.audit.auditedProfiles)) errors.push('audit.auditedProfiles invalid');
    if (typeof data.audit.adaptationEnabled !== 'boolean')
      errors.push('audit.adaptationEnabled invalid');
  }
  if (!isObject(data.coverage)) errors.push('coverage missing');
  else checkCoverage(data.coverage, errors);
  if (!isObject(data.summary)) errors.push('summary missing');
  if (!Array.isArray(data.findings)) errors.push('findings missing');
  if (errors.length > 0 || !Array.isArray(data.findings)) return { ok: false, errors };

  const ids = new Set<string>();
  (data.findings as unknown[]).forEach((finding, index) =>
    checkFinding(finding, index, ids, errors),
  );
  if (errors.length === 0 && data.semanticAssist !== undefined) {
    errors.push(...checkSemanticAssist(data.semanticAssist, ids));
  }
  if (errors.length === 0) {
    const expected = JSON.stringify(canonicalSorted(summarize(data.findings as AuditFinding[])));
    if (JSON.stringify(canonicalSorted(data.summary)) !== expected) {
      errors.push('summary does not match the findings');
    }
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, report: data as unknown as AuditReport };
}

/**
 * Coverage must disclose every limit it reports: all subsystems present once, and a truncated
 * pass or a cut finding list never shown as `complete`.
 */
function checkCoverage(coverage: Json, errors: string[]): void {
  const list = Array.isArray(coverage.subsystems) ? (coverage.subsystems as unknown[]) : null;
  if (!list) {
    errors.push('coverage.subsystems missing');
    return;
  }
  const seen = new Map<string, string>();
  for (const item of list) {
    if (
      !isObject(item) ||
      typeof item.id !== 'string' ||
      !(AUDIT_SUBSYSTEM_IDS as readonly string[]).includes(item.id) ||
      !oneOf(AUDIT_COVERAGE_LEVELS, item.level) ||
      typeof item.name !== 'string' ||
      typeof item.note !== 'string' ||
      item.note === ''
    ) {
      errors.push('coverage.subsystems entry invalid');
      continue;
    }
    if (seen.has(item.id)) errors.push(`coverage.subsystems duplicate ${item.id}`);
    seen.set(item.id, item.level);
  }
  for (const id of AUDIT_SUBSYSTEM_IDS) {
    if (!seen.has(id)) errors.push(`coverage.subsystems lacks ${id}`);
  }
  if (coverage.analysisTruncated === true && seen.get('color-contrast') === 'complete') {
    errors.push('coverage hides a truncated analysis');
  }
  if (
    typeof coverage.truncatedFindings === 'number' &&
    coverage.truncatedFindings > 0 &&
    seen.get('findings') === 'complete'
  ) {
    errors.push('coverage hides truncated findings');
  }
  for (const id of ['shadow-dom', 'iframes', 'borders-focus']) {
    if (seen.has(id) && seen.get(id) !== 'unsupported')
      errors.push(`coverage claims ${id} is audited`);
  }
  if (
    !Array.isArray(coverage.budgetsReached) ||
    !(coverage.budgetsReached as unknown[]).every((b) => typeof b === 'string')
  ) {
    errors.push('coverage.budgetsReached invalid');
  }
}

/** Every string of a report is plain visible text: no control, bidi, zero-width or surrogate character. */
function collectUnsafeStrings(value: unknown, path: string, errors: string[]): void {
  if (errors.length >= 20) return;
  if (typeof value === 'string') {
    if (hasUnsafeCharacters(value)) errors.push(`${path || 'report'}: unsafe character`);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => collectUnsafeStrings(item, `${path}[${i}]`, errors));
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (hasUnsafeCharacters(key)) errors.push(`${path}: unsafe character in a key`);
      collectUnsafeStrings(item, path ? `${path}.${key}` : key, errors);
    }
  }
}

function canonicalSorted(value: unknown): unknown {
  return JSON.parse(canonicalJson(value, 0)) as unknown;
}

// ---------------------------------------------------------------------------------------
// Standalone HTML report
// ---------------------------------------------------------------------------------------

function formatValue(value: AuditValue): string {
  switch (value.kind) {
    case 'color':
      return value.hex;
    case 'colors':
      return `${value.foreground} on ${value.background}`;
    case 'number':
      return `${Number.isInteger(value.value) ? String(value.value) : value.value.toFixed(3)}${value.unit ?? ''}`;
    case 'text':
      return value.text;
    case 'list':
      return value.items.join(', ');
  }
}

/** The text a report (HTML or UI) shows for one evidence value. */
export function describeEvidence(item: AuditEvidence): string {
  return formatValue(item.value);
}

const STYLE = `
:root{color-scheme:light dark;--fg:#1a1a1a;--bg:#ffffff;--muted:#555555;--line:#c8c8c8;--card:#f6f6f6}
@media (prefers-color-scheme:dark){:root{--fg:#ececec;--bg:#161616;--muted:#a8a8a8;--line:#444444;--card:#202020}}
body{font:15px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg);margin:0 auto;max-width:60rem;padding:1rem}
h1{font-size:1.4rem;margin:.2rem 0}h2{font-size:1.1rem;margin-top:1.6rem}
.meta,.note{color:var(--muted)}
table{border-collapse:collapse}th,td{border:1px solid var(--line);padding:.25rem .6rem;text-align:left}
details{border:1px solid var(--line);border-radius:6px;background:var(--card);margin:.6rem 0;padding:.3rem .8rem}
summary{cursor:pointer;font-weight:600;padding:.3rem 0}
.sev{display:inline-block;min-width:5.5rem;font-weight:700}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.2rem 1rem}dt{color:var(--muted)}dd{margin:0}
code{font-family:ui-monospace,monospace;font-size:.9em}
`;

function evidenceRows(evidence: readonly AuditEvidence[]): string {
  if (evidence.length === 0) return '';
  const rows = evidence
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.label)}</td><td><code>${escapeHtml(formatValue(item.value))}</code></td><td>${escapeHtml(BASIS_LABEL[item.basis])}</td></tr>`,
    )
    .join('');
  return `<table><thead><tr><th scope="col">Evidence</th><th scope="col">Value</th><th scope="col">Basis</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function coverageHtml(coverage: AuditCoverage): string {
  const limited =
    coverage.analysisTruncated ||
    coverage.truncatedFindings > 0 ||
    coverage.subsystems.some((s) => s.level === 'partial' && /truncated/i.test(s.note));
  const rows = coverage.subsystems
    .map(
      (s) =>
        `<tr><th scope="row">${escapeHtml(s.name)}</th><td>${escapeHtml(COVERAGE_LEVEL_LABEL[s.level])}</td><td>${escapeHtml(s.note)}</td></tr>`,
    )
    .join('');
  return `<h2>Coverage</h2>
${limited ? '<p><strong>Audit truncated: coverage limited.</strong> Parts of this page were not audited; a clean result there says nothing.</p>' : ''}
<p class="note">${coverage.elementsAnalyzed} elements analyzed. “No findings” means nothing was found in what was audited, never that the page is free of problems.</p>
<table><thead><tr><th scope="col">Area</th><th scope="col">Coverage</th><th scope="col">What was and was not looked at</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function findingHtml(finding: AuditFinding): string {
  const profiles =
    finding.visionProfiles.length > 0 ? finding.visionProfiles.join(', ') : 'not profile-specific';
  const simulation = finding.simulation
    .map((s) => `${s.profile}: ${s.model} (${MODEL_CONFIDENCE_LABEL[s.modelConfidence]})`)
    .join('; ');
  const targets = finding.affected
    .map(
      (a) =>
        `<li><code>${escapeHtml(a.locator.path)}</code>${a.locator.text ? ` “${escapeHtml(a.locator.text)}”` : ''}</li>`,
    )
    .join('');
  const more =
    finding.affectedCount > finding.affected.length
      ? `<p class="note">Showing ${finding.affected.length} of ${finding.affectedCount} elements.</p>`
      : '';
  const recommendation = finding.recommendation;
  const actions = recommendation.actions.map((a) => `<li>${escapeHtml(a)}</li>`).join('');
  const wcag = finding.wcag.map((w) => `${w.criterion} ${w.name}`).join('; ');
  return `<details id="${escapeHtml(finding.id)}">
<summary><span class="sev">${SEVERITY_GLYPH[finding.severity]} ${escapeHtml(SEVERITY_LABEL[finding.severity])}</span> ${escapeHtml(finding.title)} <span class="meta">(${finding.affectedCount} element${finding.affectedCount === 1 ? '' : 's'})</span></summary>
<p>${escapeHtml(finding.summary)}</p>
<dl>
<dt>Rule</dt><dd><code>${escapeHtml(finding.ruleId)}</code> · ${escapeHtml(CATEGORY_LABEL[finding.category])}</dd>
<dt>Assessment</dt><dd>${escapeHtml(ASSESSMENT_LABEL[finding.assessment])}</dd>
<dt>Confidence</dt><dd>${escapeHtml(CONFIDENCE_LABEL[finding.confidence])}</dd>
<dt>Vision profiles</dt><dd>${escapeHtml(profiles)}</dd>
${simulation ? `<dt>Simulation model</dt><dd>${escapeHtml(simulation)}</dd>` : ''}
<dt>ColorAdapt</dt><dd>${escapeHtml(ADAPTATION_LABEL[finding.adaptationStatus])}</dd>
<dt>Source</dt><dd>${escapeHtml(finding.source.primary)} ${escapeHtml(finding.source.subsystem)}</dd>
${wcag ? `<dt>Related to</dt><dd>${escapeHtml(wcag)}</dd>` : ''}
</dl>
${evidenceRows(finding.evidence)}
<h3>Recommendation</h3>
<p>${escapeHtml(recommendation.summary)}</p>
<ul>${actions}</ul>
${recommendation.observed ? `<p class="note">Observed: <code>${escapeHtml(recommendation.observed)}</code></p>` : ''}
${recommendation.coloradapt ? `<p class="note">${escapeHtml(recommendation.coloradapt)}</p>` : ''}
${recommendation.suggestedColor ? `<p class="note">Suggested color: <code>${escapeHtml(recommendation.suggestedColor.hex)}</code> — ${escapeHtml(recommendation.suggestedColor.note)}</p>` : ''}
<h3>Affected elements</h3>
<ul>${targets}</ul>${more}
<p class="note">${escapeHtml(finding.sourceNote)}</p>
</details>`;
}

/**
 * A standalone page: one file, inline style, no script, no font or image from anywhere, no
 * link that loads anything, and a Content-Security-Policy that forbids all of it. Every string
 * that came from the page is HTML-escaped; none is ever inserted as markup.
 */
export function renderAuditHtml(report: AuditReport): string {
  const s = report.summary;
  const rows = AUDIT_SEVERITIES.map(
    (sev) =>
      `<tr><th scope="row">${SEVERITY_GLYPH[sev]} ${escapeHtml(SEVERITY_LABEL[sev])}</th><td>${s.bySeverity[sev]}</td></tr>`,
  ).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ColorAdapt audit — ${escapeHtml(report.page.origin)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>ColorAdapt developer audit</h1>
<p class="meta">${escapeHtml(report.page.origin)}${escapeHtml(report.page.pathname)} · generated ${escapeHtml(report.generatedAt)} · ColorAdapt ${escapeHtml(report.tool.version)} · schema ${report.schemaVersion}</p>
<p class="note">Measured on the original page, not on ColorAdapt’s adapted appearance. Findings are engineering estimates and review prompts; they are not a conformance statement and there is no score. Vision profiles audited: ${escapeHtml(report.audit.auditedProfiles.join(', ') || 'none')}.</p>
<h2>Summary</h2>
<p>${s.findings} finding${s.findings === 1 ? '' : 's'} affecting ${s.affectedElements} element${s.affectedElements === 1 ? '' : 's'}; ${s.adapted} compensated by ColorAdapt, ${s.unresolved} not; ${s.manualReview} need manual review.</p>
<p>${escapeHtml(assessmentCountsLine(s))}</p>
<table><thead><tr><th scope="col">Severity</th><th scope="col">Findings</th></tr></thead><tbody>${rows}</tbody></table>
${coverageHtml(report.coverage)}
<h2>Findings</h2>
${report.findings.length === 0 ? '<p>No findings.</p>' : report.findings.map(findingHtml).join('\n')}
${report.semanticAssist ? semanticAssistHtml(report.semanticAssist, new Map(report.findings.map((f) => [f.id, f.title]))) : ''}
</body>
</html>
`;
}
