import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  AUDIT_PORT_NAME,
  describesSamePage,
  type AuditProfileScope,
  type AuditSnapshot,
  type HighlightResult,
} from '@core/audit';
import { sendToTab } from '@infrastructure/messaging';

export type SessionStatus = 'starting' | 'ready' | 'refreshing' | 'error' | 'disconnected';

export interface AuditSession {
  readonly snapshot: AuditSnapshot | null;
  readonly status: SessionStatus;
  readonly error: string | null;
  /**
   * The tab's address changed (a route change with or without DOM mutations) and the snapshot has
   * not caught up: its page metadata is stale until the refresh that this triggers lands.
   */
  readonly routePending: boolean;
  /** A fresh pass now (the content script re-reads the page; no reload needed). */
  readonly refresh: (scope: AuditProfileScope) => Promise<void>;
  readonly highlight: (
    findingId: string,
    index: number,
    scroll: boolean,
  ) => Promise<HighlightResult | null>;
  readonly clearHighlight: () => Promise<void>;
  readonly noteExport: () => Promise<void>;
}

/**
 * One developer-audit session with the content script of `tabId` (docs/DEVELOPER_AUDIT.md):
 * a port that keeps the session alive (when this page closes the port drops and the page forgets
 * the highlight), typed messages for everything else. The page pushes "a newer snapshot exists";
 * this fetches it.
 */
export function useAuditSession(
  tabId: number | null,
  initialScope: AuditProfileScope,
): AuditSession {
  const [snapshot, setSnapshot] = useState<AuditSnapshot | null>(null);
  const [status, setStatus] = useState<SessionStatus>('starting');
  const [error, setError] = useState<string | null>(null);
  const [routePending, setRoutePending] = useState(false);
  const scope = useRef<AuditProfileScope>(initialScope);
  const latest = useRef<AuditSnapshot | null>(null);
  useEffect(() => {
    latest.current = snapshot;
  }, [snapshot]);

  const fetchLatest = useCallback(async () => {
    if (tabId === null) return;
    const fetched = await sendToTab(tabId, 'AUDIT_GET', undefined);
    if (fetched)
      setSnapshot((current) =>
        current && current.generation >= fetched.generation ? current : fetched,
      );
  }, [tabId]);

  const refresh = useCallback(
    async (next: AuditProfileScope) => {
      if (tabId === null) return;
      scope.current = next;
      setStatus('refreshing');
      setError(null);
      try {
        const result = await sendToTab(tabId, 'AUDIT_RUN', { scope: next });
        setSnapshot((current) =>
          current && current.generation > result.generation ? current : result,
        );
        setRoutePending(false);
        setStatus('ready');
      } catch {
        setError(
          'The page did not answer. It may have been closed, reloaded, or is not a page ColorAdapt can run on.',
        );
        setStatus('error');
      }
    },
    [tabId],
  );

  useEffect(() => {
    if (tabId === null) return undefined;
    let closed = false;
    const port = browser.tabs.connect(tabId, { name: AUDIT_PORT_NAME });
    port.onMessage.addListener(() => {
      if (!closed) void fetchLatest().catch(() => undefined);
    });
    port.onDisconnect.addListener(() => {
      if (!closed) setStatus('disconnected');
    });
    void refresh(scope.current);
    const end = (): void => {
      closed = true;
      void sendToTab(tabId, 'AUDIT_CLOSE', undefined).catch(() => undefined);
      port.disconnect();
    };
    window.addEventListener('pagehide', end);
    return () => {
      window.removeEventListener('pagehide', end);
      end();
    };
  }, [tabId, fetchLatest, refresh]);

  // Route changes. M4 deliberately never patches the page's History API, and neither does the audit:
  // the extension learns of a new address from the browser (`tabs.onUpdated` carries `url` for tabs
  // the extension has host access to, including single-page route changes). Only the sanitized origin
  // and path matter, so a query/fragment-only change does nothing; a different route marks the
  // metadata pending and asks the page for a fresh pass, so a report never pairs a new route with
  // findings of the old one.
  useEffect(() => {
    if (tabId === null) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onUpdated = (id: number, change: { url?: string }): void => {
      if (id !== tabId || typeof change.url !== 'string') return;
      const current = latest.current;
      if (!current || describesSamePage(current.page, change.url)) return;
      setRoutePending(true);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refresh(scope.current);
      }, ROUTE_REFRESH_DELAY_MS);
    };
    browser.tabs.onUpdated.addListener(onUpdated);
    return () => {
      browser.tabs.onUpdated.removeListener(onUpdated);
      if (timer !== null) clearTimeout(timer);
    };
  }, [tabId, refresh]);

  const highlight = useCallback(
    async (findingId: string, index: number, scroll: boolean) => {
      if (tabId === null) return null;
      try {
        return await sendToTab(tabId, 'AUDIT_HIGHLIGHT', { findingId, index, scroll });
      } catch {
        return null;
      }
    },
    [tabId],
  );

  const clearHighlight = useCallback(async () => {
    if (tabId === null) return;
    await sendToTab(tabId, 'AUDIT_CLEAR_HIGHLIGHT', undefined).catch(() => undefined);
  }, [tabId]);

  const noteExport = useCallback(async () => {
    if (tabId === null) return;
    await sendToTab(tabId, 'AUDIT_NOTE_EXPORT', undefined).catch(() => undefined);
  }, [tabId]);

  return { snapshot, status, error, routePending, refresh, highlight, clearHighlight, noteExport };
}

/** A route change usually comes with DOM changes of its own; let them settle before the pass. */
export const ROUTE_REFRESH_DELAY_MS = 600;
