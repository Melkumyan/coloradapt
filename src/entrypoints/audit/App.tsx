import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import {
  NO_FILTERS,
  auditFileName,
  createAuditReport,
  filterFindings,
  isFiltering,
  renderAuditHtml,
  serializeAuditReport,
  summarize,
  type AuditFilters,
  type AuditProfileScope,
} from '@core/audit';
import { VISION_PROFILE_INFO } from '@domain/models';
import { useSettings } from '@features/settings';
import { AssistPanel } from './assist-components';
import { CoveragePanel, FilterPanel, FindingCard, SummaryBar } from './components';
import { downloadText } from './download';
import { useAuditSession } from './use-audit-session';
import { useSemanticAssist } from './use-semantic-assist';

/** Findings drawn at first and per "Show more": a big page must not freeze the page that audits it. */
const PAGE_SIZE = 200;

function readTabId(): number | null {
  const raw = new URLSearchParams(window.location.search).get('tabId');
  if (raw === null || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

const SCOPE_LABEL: Record<AuditProfileScope, string> = {
  auto: 'Automatic (active profile, or the three major ones for normal vision)',
  active: 'Active profile only',
  major: 'Protanopia, deuteranopia and tritanopia',
};

export function App(): JSX.Element {
  const [tabId] = useState(readTabId);
  const [scope, setScope] = useState<AuditProfileScope>('auto');
  const session = useAuditSession(tabId, 'auto');
  const { snapshot, status, error } = session;
  const { settings } = useSettings({ live: true });
  const assist = useSemanticAssist(tabId, snapshot, settings);
  const [assistView, setAssistView] = useState<
    'all' | 'ACCEPTED_ADVISORY' | 'UNRESOLVED' | 'REJECTED'
  >('all');
  const [filters, setFilters] = useState<AuditFilters>(NO_FILTERS);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [notice, setNotice] = useState('');

  const filtered = useMemo(() => {
    const found = snapshot ? filterFindings(snapshot.findings, filters) : [];
    // A view over the findings, not a filter of the audit: it never changes what is exported.
    return assistView === 'all'
      ? found
      : found.filter((f) => assist.entries.get(f.id)?.validatorStatus === assistView);
  }, [snapshot, filters, assistView, assist.entries]);
  const filteredSummary = useMemo(() => summarize(filtered), [filtered]);
  const filtering = isFiltering(filters) || assistView !== 'all';

  // A new snapshot may have lost the selected finding: nothing may point at it (derived, not stored).
  const ids = useMemo(
    () => new Set(snapshot?.findings.map((finding) => finding.id) ?? []),
    [snapshot],
  );
  // Focus: when the card that holds keyboard focus disappears with a live update, focus moves to the
  // "Findings" heading instead of falling to <body> (the audited page never receives focus).
  const findingsHeading = useRef<HTMLHeadingElement>(null);
  const focusedFinding = useRef<string | null>(null);
  useEffect(() => {
    const id = focusedFinding.current;
    if (id === null || ids.has(id)) return;
    focusedFinding.current = null;
    const active = document.activeElement;
    if (active === null || active === document.body) findingsHeading.current?.focus();
  }, [ids]);
  const clearHighlight = session.clearHighlight;
  const highlight = session.highlight;
  const selected = useRef<{ id: string; index: number } | null>(null);
  const expanded = expandedId !== null && ids.has(expandedId) ? expandedId : null;
  const shownIndex = expanded === null ? null : highlighted;
  useEffect(() => {
    if (expandedId !== null && !ids.has(expandedId)) {
      selected.current = null;
      void clearHighlight();
      return;
    }
    // The elements behind the highlight may have been replaced: ask the page to find them again.
    const current = selected.current;
    if (current && ids.has(current.id)) {
      void highlight(current.id, current.index, false).then((result) => {
        if (result && !result.ok) setHighlighted(null);
      });
    }
  }, [snapshot, ids, expandedId, clearHighlight, highlight]);

  const show = useCallback(
    (id: string, index: number, scroll: boolean) => {
      selected.current = { id, index };
      void highlight(id, index, scroll).then((result) => {
        if (result?.ok) {
          selected.current = { id, index: result.index };
          setHighlighted(result.index);
        } else {
          setHighlighted(null);
        }
      });
    },
    [highlight],
  );

  const toggle = useCallback(
    (id: string) => {
      if (expanded === id) {
        setExpandedId(null);
        setHighlighted(null);
        selected.current = null;
        void clearHighlight();
        return;
      }
      setExpandedId(id);
      setHighlighted(null);
      show(id, 0, false);
    },
    [expanded, clearHighlight, show],
  );

  const exportAs = useCallback(
    (kind: 'json' | 'html') => {
      if (!snapshot || session.routePending) return;
      const report = createAuditReport(snapshot, Date.now(), assist.report());
      const name = auditFileName(report.page, report.generatedAt, kind);
      if (kind === 'json') downloadText(name, serializeAuditReport(report), 'application/json');
      else downloadText(name, renderAuditHtml(report), 'text/html');
      void session.noteExport();
      setNotice(`Saved ${name}`);
    },
    [snapshot, session, assist],
  );

  if (tabId === null) {
    return (
      <main className="audit">
        <h1>ColorAdapt developer audit</h1>
        <p role="alert">
          Open this page from the ColorAdapt popup (“Developer audit”) while the page you want to
          audit is the active tab.
        </p>
      </main>
    );
  }

  const shown = filtered.slice(0, visible);
  return (
    <main className="audit" aria-busy={status === 'starting' || status === 'refreshing'}>
      <header className="audit__header">
        <h1>ColorAdapt developer audit</h1>
        {snapshot && (
          <p className="muted" data-testid="page-line">
            {snapshot.page.origin}
            {snapshot.page.pathname} · audited {new Date(snapshot.timestamp).toLocaleTimeString()} ·
            profiles:{' '}
            {snapshot.settings.auditedProfiles.length === 0
              ? 'none (normal vision: no simulation)'
              : snapshot.settings.auditedProfiles
                  .map((p) => VISION_PROFILE_INFO[p].label)
                  .join(', ')}
          </p>
        )}
        <div className="audit__actions">
          <label htmlFor="audit-scope">Profiles to audit</label>
          <select
            id="audit-scope"
            value={scope}
            onChange={(event) => {
              const next = event.target.value as AuditProfileScope;
              setScope(next);
              void session.refresh(next);
            }}
          >
            {(Object.keys(SCOPE_LABEL) as AuditProfileScope[]).map((key) => (
              <option key={key} value={key}>
                {SCOPE_LABEL[key]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void session.refresh(scope)}
            disabled={status === 'refreshing'}
          >
            Refresh audit
          </button>
          <button
            type="button"
            onClick={() => exportAs('json')}
            disabled={!snapshot || session.routePending}
          >
            Export JSON
          </button>
          <button
            type="button"
            onClick={() => exportAs('html')}
            disabled={!snapshot || session.routePending}
          >
            Export HTML report
          </button>
        </div>
        <p className="muted">
          Exports contain every finding of this snapshot (filters only change the view). They hold
          no form values, no page query or fragment, and no script.{' '}
          {notice && <span role="status">{notice}</span>}
        </p>
      </header>

      {status === 'disconnected' && (
        <p role="alert" className="notice">
          The audited page was closed or navigated away. Reload it and open the audit again.
        </p>
      )}
      {status === 'error' && error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {session.routePending && (
        <p role="status" className="notice" data-testid="route-pending">
          The page address changed. Refreshing the audit; export is paused until the findings match
          the new page.
        </p>
      )}
      {status === 'starting' && !snapshot && <p role="status">Auditing the page…</p>}

      {snapshot && (
        <>
          <SummaryBar summary={snapshot.summary} />
          <CoveragePanel coverage={snapshot.coverage} />
          <AssistPanel assist={assist} />
          {assist.entries.size > 0 && (
            <p>
              <label htmlFor="assist-view">AI-assisted interpretation: </label>
              <select
                id="assist-view"
                value={assistView}
                onChange={(event) => setAssistView(event.target.value as typeof assistView)}
              >
                <option value="all">All findings</option>
                <option value="ACCEPTED_ADVISORY">Likely meaning (advisory)</option>
                <option value="UNRESOLVED">Needs review</option>
                <option value="REJECTED">Interpretation rejected</option>
              </select>
            </p>
          )}
          <FilterPanel
            findings={snapshot.findings}
            filters={filters}
            onChange={(next) => {
              setFilters(next);
              setVisible(PAGE_SIZE);
            }}
            onClear={() => setFilters(NO_FILTERS)}
            filtering={filtering}
          />
          <section
            aria-labelledby="findings-heading"
            onFocus={(event) => {
              const owner = event.target.closest('[data-testid="finding"]');
              focusedFinding.current = owner?.getAttribute('data-finding-id') ?? null;
            }}
          >
            <h2 id="findings-heading" ref={findingsHeading} tabIndex={-1}>
              Findings
            </h2>
            <p role="status" data-testid="filter-status">
              {filtering
                ? `Showing ${filtered.length} of ${snapshot.findings.length} findings (${filteredSummary.affectedElements} elements).`
                : `${snapshot.findings.length} findings.`}
            </p>
            {snapshot.findings.length === 0 && (
              <p>
                No findings. That is not a statement that the page is accessible: ColorAdapt checks
                a few kinds of color problem and lists what it cannot analyze.
              </p>
            )}
            {shown.map((finding) => (
              <FindingCard
                key={finding.id}
                finding={finding}
                expanded={expanded === finding.id}
                highlighted={expanded === finding.id ? shownIndex : null}
                onToggle={() => toggle(finding.id)}
                onHighlight={(index, scroll) => show(finding.id, index, scroll)}
                {...(assist.entries.get(finding.id)
                  ? { assist: assist.entries.get(finding.id), provider: assist.provider }
                  : {})}
              />
            ))}
            {filtered.length > shown.length && (
              <p>
                Showing {shown.length} of {filtered.length}.{' '}
                <button type="button" onClick={() => setVisible((n) => n + PAGE_SIZE)}>
                  Show {Math.min(PAGE_SIZE, filtered.length - shown.length)} more
                </button>
              </p>
            )}
          </section>
        </>
      )}
    </main>
  );
}
