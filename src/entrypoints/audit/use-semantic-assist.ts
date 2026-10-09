import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AssistCoverage,
  type AssistStats,
  type AuditSemanticAssistEntry,
  type AuditSemanticAssistReport,
  type AuditSnapshot,
} from '@core/audit';
import {
  SemanticAssistEngine,
  assistReport,
  createSemanticProvider,
  emptyAssistReport,
  entryOf,
  type ProviderIdentity,
  type SemanticAssistDiagnostics,
} from '@core/semantic-ai';
import type { UserSettings } from '@domain/models';
import {
  requestWebsiteContentConsent,
  watchWebsiteContentRevoked,
  websiteContentAllowed,
} from '@infrastructure/browser/data-consent';
import { sendToTab } from '@infrastructure/messaging';

/**
 * The audit page's side of the AI-assisted review (M11, docs/AI_SEMANTIC_ENGINE.md).
 *
 * The review is an explicit action: nothing here runs until the developer presses the button, and
 * nothing at all runs unless the setting is on. The provider lives in this extension page (never in
 * the content script, so a page's own CSP and origin never touch the local runtime). Results are
 * memory only: they are never written to storage and they die with the page.
 *
 * An answer is shown only while it still describes the page. It is bound to the route, the profiles
 * audited and the fingerprint of the packet it answered; after every new snapshot the page's packets
 * are read again and an answer whose fingerprint changed (the element was replaced, its state or
 * labels changed) is hidden, whatever the model said. Closing the page, turning the setting off,
 * changing the provider, the route or the audited profiles cancels what is in flight.
 */

interface Stored {
  readonly entry: AuditSemanticAssistEntry;
  readonly inputHash: string;
}

interface Verified {
  readonly generation: number;
  readonly hashes: ReadonlyMap<string, string>;
}

const EMPTY_STATS: AssistStats = {
  eligible: 0,
  queried: 0,
  deduped: 0,
  cacheHits: 0,
  accepted: 0,
  rejected: 0,
  unresolved: 0,
  modelErrors: 0,
  timeouts: 0,
  notQueued: 0,
};

export interface SemanticAssistState {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly coverage: AssistCoverage;
  readonly provider: ProviderIdentity;
  readonly stats: AssistStats | null;
  /** Why the runtime gave no answer (`unavailable`, `http-error`, `timeout`, ...), when it did not. */
  readonly failure: string | null;
  /** Findings the last run left alone because their elements differ. */
  readonly heterogeneous: number;
  /** Entries that still describe the current snapshot, by finding id. */
  readonly entries: ReadonlyMap<string, AuditSemanticAssistEntry>;
  readonly run: () => Promise<void>;
  /** For export: the section of the report. `disabled`/`not-run` when nothing was interpreted. */
  readonly report: () => AuditSemanticAssistReport;
  readonly diagnostics: () => SemanticAssistDiagnostics | null;
}

export function useSemanticAssist(
  tabId: number | null,
  snapshot: AuditSnapshot | null,
  settings: UserSettings | null,
): SemanticAssistState {
  const enabled = settings?.semanticAIEnabled === true;
  const config = useMemo(
    () => ({
      enabled,
      provider: settings?.semanticAIProvider ?? 'local-ollama',
      endpoint: settings?.semanticAIEndpoint ?? '',
      model: settings?.semanticAIModel ?? '',
    }),
    [
      enabled,
      settings?.semanticAIProvider,
      settings?.semanticAIEndpoint,
      settings?.semanticAIModel,
    ],
  );
  const engine = useMemo(
    () =>
      new SemanticAssistEngine(createSemanticProvider(config, undefined, websiteContentAllowed)),
    [config],
  );

  const [results, setResults] = useState<ReadonlyMap<string, Stored>>(new Map());
  const [verified, setVerified] = useState<Verified | null>(null);
  const [summary, setSummary] = useState<{
    coverage: AssistCoverage;
    stats: AssistStats;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const token = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const [reportedModel, setReportedModel] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [heterogeneous, setHeterogeneous] = useState(0);

  const cancel = useCallback((): void => {
    token.current += 1;
    abort.current?.abort();
    abort.current = null;
  }, []);

  const page = snapshot ? `${snapshot.page.origin}${snapshot.page.pathname}` : '';
  const profiles = snapshot
    ? `${snapshot.settings.activeProfile}|${snapshot.settings.auditedProfiles.join(',')}`
    : '';
  const context = `${page}|${profiles}`;

  // A new provider, setting, route or profile scope is a new question: nothing of the old one survives.
  useEffect(() => {
    return () => {
      cancel();
      engine.cancelAll();
      // Turning the review off, or changing provider, route or profiles, forgets what it answered.
      engine.cache.clear();
      setResults(new Map());
      setVerified(null);
      setSummary(null);
      setRunning(false);
      setReportedModel(null);
      setFailure(null);
      setHeterogeneous(0);
    };
  }, [engine, context, cancel]);

  const run = useCallback(async (): Promise<void> => {
    if (!enabled || tabId === null || running) return;
    // Firefox: the optional `websiteContent` consent is asked for here, first, from the click (nothing is read
    // from the page, let alone sent, before it is granted). Denial ends the run: no retry, no request.
    setRunning(true);
    const consent = await requestWebsiteContentConsent();
    if (consent === 'denied') {
      setRunning(false);
      cancel();
      engine.cancelAll();
      setFailure('consent-denied');
      setSummary({ coverage: 'unavailable', stats: EMPTY_STATS });
      return;
    }
    cancel();
    engine.cancelAll();
    const mine = token.current;
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    setFailure(null);
    try {
      const response = await sendToTab(tabId, 'AUDIT_SEMANTIC_CASES', { includeIds: [] });
      if (token.current !== mine) return;
      setHeterogeneous(response.heterogeneous.length);
      const queries = new Map(response.cases.map((c) => [c.findingId, c]));
      setVerified({
        generation: response.generation,
        hashes: new Map(response.cases.map((c) => [c.findingId, c.bound.inputHash])),
      });
      const done = await engine.run(
        response.cases.map((c) => ({ id: c.findingId, bound: c.bound, priority: c.priority })),
        {
          signal: controller.signal,
          isCurrent: () => token.current === mine,
          onResult: (outcome) => {
            const asked = queries.get(outcome.id);
            if (!asked) return;
            if (outcome.model) setReportedModel(outcome.model);
            const entry = entryOf(outcome, asked.bound.query, {
              instances: asked.instances,
              sampled: asked.sampled,
            });
            if (!entry) {
              setFailure((current) => current ?? outcome.interpreted.reason);
              return;
            }
            setResults((current) =>
              new Map(current).set(outcome.id, { entry, inputHash: outcome.inputHash }),
            );
          },
        },
      );
      if (token.current !== mine) return;
      // Findings left alone (not read, or their elements differ) stay manual review, and the run says so.
      const unasked = Math.max(0, response.eligible - response.cases.length);
      setSummary({
        coverage: done.coverage === 'completed' && unasked > 0 ? 'partial' : done.coverage,
        stats: {
          ...done.stats,
          eligible: response.eligible,
          notQueued: done.stats.notQueued + unasked,
        },
      });
    } catch {
      if (token.current === mine) {
        setSummary({ coverage: 'unavailable', stats: EMPTY_STATS });
      }
    } finally {
      if (token.current === mine) {
        abort.current = null;
        setRunning(false);
      }
    }
  }, [enabled, tabId, running, cancel, engine]);

  // After every new snapshot: are the answers still answers to what the page now holds?
  const generation = snapshot?.generation ?? 0;
  // Answers are held that the packets read at the last verification (or at the start of the run) do not
  // cover, because the page produced a newer snapshot since. Answers that arrive while the snapshot is
  // unchanged are covered already: no re-reading per answer.
  const behind = results.size > 0 && verified !== null && verified.generation < generation;
  useEffect(() => {
    if (!behind || tabId === null || !enabled) return undefined;
    let current = true;
    const mine = token.current;
    void sendToTab(tabId, 'AUDIT_SEMANTIC_CASES', { includeIds: [...results.keys()] })
      .then((response) => {
        if (!current || token.current !== mine) return;
        setVerified({
          generation: response.generation,
          hashes: new Map(response.cases.map((c) => [c.findingId, c.bound.inputHash])),
        });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
    // `results` is read for its keys only, at the moment the page moved on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, behind, tabId, enabled]);

  // Firefox: removing the consent in about:addons ends what is in flight and forgets what it answered.
  useEffect(
    () =>
      watchWebsiteContentRevoked(() => {
        cancel();
        engine.cancelAll();
        engine.cache.clear();
        setResults(new Map());
        setVerified(null);
        setSummary({ coverage: 'unavailable', stats: EMPTY_STATS });
        setFailure('consent-required');
        setRunning(false);
      }),
    [cancel, engine],
  );

  // Closing the page ends everything.
  useEffect(() => {
    return () => {
      cancel();
      engine.cancelAll();
      engine.cache.clear();
    };
  }, [cancel, engine]);

  const entries = useMemo(() => {
    const out = new Map<string, AuditSemanticAssistEntry>();
    if (!snapshot || !verified || verified.generation < snapshot.generation) return out;
    for (const [id, stored] of results) {
      if (verified.hashes.get(id) === stored.inputHash) out.set(id, stored.entry);
    }
    return out;
  }, [snapshot, verified, results]);

  const provider = useMemo<ProviderIdentity>(() => {
    const identity = engine.provider.identity();
    return { provider: identity.provider, model: identity.model ?? reportedModel };
  }, [engine, reportedModel]);
  const coverage: AssistCoverage = !enabled ? 'disabled' : (summary?.coverage ?? 'not-run');

  const report = useCallback((): AuditSemanticAssistReport => {
    if (!enabled) return emptyAssistReport('disabled', { provider: 'disabled', model: null });
    if (!summary) return emptyAssistReport('not-run', provider);
    return assistReport({
      coverage: summary.coverage,
      provider,
      stats: summary.stats,
      entries: [...entries.values()],
    });
  }, [enabled, summary, provider, entries]);

  return {
    enabled,
    running,
    coverage,
    provider,
    stats: summary?.stats ?? null,
    failure,
    heterogeneous,
    entries,
    run,
    report,
    diagnostics: () => engine.diagnostics(),
  };
}
