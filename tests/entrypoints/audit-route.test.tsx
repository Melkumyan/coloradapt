import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSnapshot, type AuditSnapshot } from '@core/audit';
import { candidate } from '../core/audit/builders';

/**
 * SPA route changes (docs/DEVELOPER_AUDIT.md, "Address of the page"). The audit page learns of a new
 * address from the browser (`tabs.onUpdated`), never from a patched History API; it keeps the report
 * from pairing a new route with findings of the old one.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Listener = (id: number, change: { url?: string }) => void;
const listeners = new Set<Listener>();
const sent: Array<[number, string]> = [];
let generation = 0;
let pageUrl = 'https://example.test/a';

vi.mock('wxt/browser', () => ({
  browser: {
    tabs: {
      connect: () => ({
        onMessage: { addListener: () => undefined },
        onDisconnect: { addListener: () => undefined },
        disconnect: () => undefined,
      }),
      onUpdated: {
        addListener: (fn: Listener) => listeners.add(fn),
        removeListener: (fn: Listener) => listeners.delete(fn),
      },
    },
  },
}));

function snapshotFor(url: string): AuditSnapshot {
  generation += 1;
  const parsed = new URL(url);
  return buildSnapshot({
    candidates: [candidate()],
    generation,
    timestamp: generation,
    page: { origin: parsed.origin, pathname: parsed.pathname },
    extensionVersion: '0.1.0',
    settings: { activeProfile: 'deuteranopia', auditedProfiles: [], adaptationEnabled: false },
    coverage: {
      elementsAnalyzed: 1,
      analysisTruncated: false,
      semanticCandidates: 0,
      svgUnits: 0,
      charts: 0,
      canvases: 0,
      images: 0,
    },
  }).snapshot;
}

vi.mock('@infrastructure/messaging', () => ({
  sendToTab: (tabId: number, type: string) => {
    sent.push([tabId, type]);
    if (type === 'AUDIT_RUN' || type === 'AUDIT_GET') return Promise.resolve(snapshotFor(pageUrl));
    return Promise.resolve(undefined);
  },
}));

import {
  ROUTE_REFRESH_DELAY_MS,
  useAuditSession,
} from '../../src/entrypoints/audit/use-audit-session';

let root: Root | null = null;
let host: HTMLElement | null = null;
const probe: { current: ReturnType<typeof useAuditSession> | null } = { current: null };

function Probe(): null {
  const session = useAuditSession(7, 'auto');
  useEffect(() => {
    probe.current = session;
  });
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const runs = () => sent.filter(([, type]) => type === 'AUDIT_RUN').length;

beforeEach(async () => {
  vi.useFakeTimers();
  sent.length = 0;
  generation = 0;
  pageUrl = 'https://example.test/a';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(Probe)));
  await flush();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.useRealTimers();
  probe.current = null;
});

const navigate = (url: string) => {
  pageUrl = url;
  for (const fn of [...listeners]) fn(7, { url });
};

describe('audit session and route changes', () => {
  it('starts with one pass, the first page, and no pending route', () => {
    expect(runs()).toBe(1);
    expect(probe.current?.snapshot?.page.pathname).toBe('/a');
    expect(probe.current?.routePending).toBe(false);
    expect(listeners.size).toBe(1);
  });

  it('a query or fragment change is not a route change: nothing is pending, nothing is re-run', async () => {
    navigate('https://example.test/a?token=SECRET#private');
    await flush();
    expect(probe.current?.routePending).toBe(false);
    act(() => void vi.advanceTimersByTime(ROUTE_REFRESH_DELAY_MS + 50));
    await flush();
    expect(runs()).toBe(1);
  });

  it('another tab’s navigation is ignored', async () => {
    for (const fn of [...listeners]) fn(99, { url: 'https://example.test/other' });
    await flush();
    expect(probe.current?.routePending).toBe(false);
  });

  it('a new route marks the metadata pending, then one fresh pass replaces the snapshot', async () => {
    navigate('https://example.test/b');
    await flush();
    expect(probe.current?.routePending).toBe(true);
    expect(probe.current?.snapshot?.page.pathname).toBe('/a');
    await act(async () => {
      vi.advanceTimersByTime(ROUTE_REFRESH_DELAY_MS + 50);
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    expect(runs()).toBe(2);
    expect(probe.current?.routePending).toBe(false);
    expect(probe.current?.snapshot?.page.pathname).toBe('/b');
  });

  it('a burst of route changes costs one pass', async () => {
    for (const path of ['/b', '/c', '/d', '/e']) navigate(`https://example.test${path}`);
    await act(async () => {
      vi.advanceTimersByTime(ROUTE_REFRESH_DELAY_MS + 50);
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    expect(runs()).toBe(2);
    expect(probe.current?.snapshot?.page.pathname).toBe('/e');
  });

  it('never keeps or shows the raw address: only the sanitized path reaches the snapshot', async () => {
    navigate('https://user:pw@example.test/reset/9f8a7b6c5d4e3f2a1b0c9d8e?token=SECRET#frag');
    await act(async () => {
      vi.advanceTimersByTime(ROUTE_REFRESH_DELAY_MS + 50);
      await Promise.resolve();
    });
    await flush();
    expect(JSON.stringify(probe.current?.snapshot)).not.toMatch(/SECRET|frag|user:pw/);
  });

  it('releases the listener and its timer when the audit page closes', () => {
    navigate('https://example.test/b');
    act(() => root?.unmount());
    root = null;
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
