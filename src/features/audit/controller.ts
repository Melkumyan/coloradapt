import {
  buildSnapshot,
  sanitizePageUrl,
  type AuditDiagnostics,
  type AuditRequest,
  type AuditSnapshot,
  type HighlightRequest,
  type HighlightResult,
} from '@core/audit';
import type { UserSettings } from '@domain/models';
import { isColorAdaptOwnedMutation } from '../dynamic-analysis/ownership';
import type { AuditSources } from '../page-analysis';
import { collectAudit } from './collector';
import { AuditHighlighter } from './highlighter';
import { AuditStore } from './store';

/** Spacing of live re-audits while a session is open: a burst of mutations is one pass. */
export const AUDIT_WATCH = {
  /** Quiet time after the last mutation before a pass starts. */
  debounceMs: 400,
  /** Minimum time between the starts of two passes. */
  minIntervalMs: 1200,
} as const;

export interface AuditScheduler {
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

export interface AuditControllerOptions {
  readonly doc: Document;
  /** One read-only pass over the page layers (`ContentController.auditSources`). */
  readonly sources: () => AuditSources;
  readonly extensionVersion?: string;
  readonly now?: () => number;
  readonly scheduler?: AuditScheduler;
  /** The page address; read at the moment of each pass (an SPA changes it). */
  readonly url?: () => string;
  /** Creates the page observer of a live session (tests inject a fake). */
  readonly createObserver?: (callback: MutationCallback) => MutationObserver;
}

/**
 * The developer audit of one page (docs/DEVELOPER_AUDIT.md). It reads, it never adapts:
 *
 * - `run` collects one pass from the page layers, turns it into a snapshot and makes it current;
 * - `open` starts a live session (a debounced re-audit when the page changes; a single-page app's
 *   route change is a DOM change like any other, and the extension never hooks the browser's history)
 *   and `close` ends it, clearing the highlight; with no session open the audit
 *   costs nothing;
 * - `highlight` outlines one element of one finding.
 *
 * It owns no analysis of its own: everything it reports comes from `AuditSources`, read with
 * ColorAdapt's rules suspended, so ColorAdapt's own cues, patterns and generated images can
 * never make a page look more accessible than its source is.
 */
export class AuditController {
  readonly #doc: Document;
  readonly #sources: () => AuditSources;
  readonly #version: string;
  readonly #now: () => number;
  readonly #url: () => string;
  readonly #scheduler: AuditScheduler;
  readonly #createObserver: (callback: MutationCallback) => MutationObserver;
  readonly #store = new AuditStore();
  readonly #highlighter: AuditHighlighter;
  #observer: MutationObserver | null = null;
  #timer: number | null = null;
  #lastStart = Number.NEGATIVE_INFINITY;
  #listener: ((snapshot: AuditSnapshot) => void) | null = null;
  #last: { settings: UserSettings; request: AuditRequest } | null = null;
  #pathKey = '';
  #running = false;
  #counters = { exports: 0, passes: 0, livePasses: 0, staleDiscarded: 0 };

  constructor(options: AuditControllerOptions) {
    this.#doc = options.doc;
    this.#sources = options.sources;
    this.#version = options.extensionVersion ?? '0.0.0';
    this.#now = options.now ?? (() => Date.now());
    this.#url = options.url ?? (() => this.#doc.defaultView?.location.href ?? '');
    const view = options.doc.defaultView;
    this.#scheduler = options.scheduler ?? {
      setTimeout: (callback, ms) => (view ?? window).setTimeout(callback, ms),
      clearTimeout: (handle) => (view ?? window).clearTimeout(handle),
    };
    this.#createObserver =
      options.createObserver ??
      ((callback) => new (view?.MutationObserver ?? MutationObserver)(callback));
    this.#highlighter = new AuditHighlighter(options.doc);
  }

  get snapshot(): AuditSnapshot | null {
    return this.#store.snapshot;
  }

  /** One audit pass now. The result is current unless a newer pass was committed first. */
  run(settings: UserSettings, request: AuditRequest): AuditSnapshot {
    this.#last = { settings, request };
    return this.#pass(settings, request, false);
  }

  #pass(settings: UserSettings, request: AuditRequest, live: boolean): AuditSnapshot {
    if (this.#running) {
      // Re-entrancy cannot happen on one thread; this guards a future async collector.
      this.#counters.staleDiscarded += 1;
      return this.#store.snapshot ?? this.#empty(settings);
    }
    this.#running = true;
    try {
      const generation = this.#store.nextGeneration();
      this.#lastStart = this.#now();
      const url = this.#url();
      const page = sanitizePageUrl(url);
      const pathKey = `${page.origin}${page.pathname}`;
      if (this.#pathKey !== '' && pathKey !== this.#pathKey) this.#highlighter.hide(); // another route: old targets mean nothing
      this.#pathKey = pathKey;

      const collected = collectAudit({
        doc: this.#doc,
        sources: this.#sources(),
        settings,
        scope: request.scope,
      });
      const built = buildSnapshot({
        candidates: collected.candidates,
        generation,
        timestamp: this.#now(),
        page,
        extensionVersion: this.#version,
        settings: {
          activeProfile: settings.visionProfile,
          auditedProfiles: collected.profiles,
          adaptationEnabled: settings.enabled,
        },
        coverage: collected.coverage,
      });
      if (!this.#store.commit(built.snapshot, built.members, collected.elements)) {
        this.#counters.staleDiscarded += 1;
        return this.#store.snapshot ?? built.snapshot;
      }
      this.#counters.passes += 1;
      if (live) this.#counters.livePasses += 1;
      // A highlight belongs to a finding: when the element is no longer in any (fixed, or gone),
      // the outline goes too instead of pointing at something the audit no longer reports.
      const outlined = this.#highlighter.target;
      if (outlined && !this.#store.hasElement(outlined)) this.#highlighter.hide();
      else this.#highlighter.refresh();
      return built.snapshot;
    } finally {
      this.#running = false;
    }
  }

  #empty(settings: UserSettings): AuditSnapshot {
    return buildSnapshot({
      candidates: [],
      generation: 0,
      timestamp: this.#now(),
      page: sanitizePageUrl(this.#url()),
      extensionVersion: this.#version,
      settings: {
        activeProfile: settings.visionProfile,
        auditedProfiles: [],
        adaptationEnabled: settings.enabled,
      },
      coverage: {
        elementsAnalyzed: 0,
        analysisTruncated: false,
        semanticCandidates: 0,
        svgUnits: 0,
        charts: 0,
        canvases: 0,
        images: 0,
      },
    }).snapshot;
  }

  // ------------------------------------------------------------------------- session

  /** Starts a live session: while open, page changes and navigations re-audit the page (batched). */
  open(onChange: (snapshot: AuditSnapshot) => void): void {
    this.#listener = onChange;
    if (this.#observer) return;
    const root = this.#doc.documentElement;
    this.#observer = this.#createObserver((records) => {
      // Our own writes (ids, injected style, chart nodes, the highlight box) are not the page changing.
      if (records.every((record) => isColorAdaptOwnedMutation(record))) return;
      this.#highlighter.refresh();
      this.#schedule();
    });
    this.#observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  }

  /** Ends the session: no observer, no timer, no highlight. The last snapshot stays readable. */
  close(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    if (this.#timer !== null) this.#scheduler.clearTimeout(this.#timer);
    this.#timer = null;
    this.#listener = null;
    this.#highlighter.hide();
  }

  get watching(): boolean {
    return this.#observer !== null;
  }

  #schedule(): void {
    if (this.#timer !== null || !this.#last) return;
    const wait = Math.max(
      AUDIT_WATCH.debounceMs,
      AUDIT_WATCH.minIntervalMs - (this.#now() - this.#lastStart),
    );
    this.#timer = this.#scheduler.setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, wait);
  }

  /** Runs the pending live pass now (tests, and the end of a debounce). */
  flush(): AuditSnapshot | null {
    if (this.#timer !== null) {
      this.#scheduler.clearTimeout(this.#timer);
      this.#timer = null;
    }
    const last = this.#last;
    if (!last || !this.#listener) return null;
    const snapshot = this.#pass(last.settings, last.request, true);
    this.#listener(snapshot);
    return snapshot;
  }

  // ----------------------------------------------------------------------- highlight

  highlight(request: HighlightRequest): HighlightResult {
    const count = this.#store.count(request.findingId);
    if (count === 0) return { ok: false, reason: 'unknown-finding', count: 0 };
    const index = ((Math.trunc(request.index) % count) + count) % count; // next/previous wrap around
    const element = this.#store.elementAt(request.findingId, index);
    if (!element || !this.#highlighter.show(element, request.scroll)) {
      this.#highlighter.hide();
      return { ok: false, reason: 'gone', count };
    }
    const instanceId = this.#store.instanceAt(request.findingId, index);
    const finding = this.#store.snapshot?.findings.find((f) => f.id === request.findingId);
    const locator =
      finding?.affected.find((entry) => entry.instanceId === instanceId)?.locator ?? null;
    return { ok: true, index, count, locator };
  }

  clearHighlight(): void {
    this.#highlighter.hide();
  }

  noteExport(): void {
    this.#counters.exports += 1;
  }

  diagnostics(): AuditDiagnostics {
    const summary = this.#store.snapshot?.summary;
    return {
      auditFindings: summary?.affectedElements ?? 0,
      auditGroups: summary?.findings ?? 0,
      auditManualReview: summary?.manualReview ?? 0,
      auditHigh: (summary?.bySeverity.critical ?? 0) + (summary?.bySeverity.high ?? 0),
      auditMedium: summary?.bySeverity.medium ?? 0,
      auditLow: (summary?.bySeverity.low ?? 0) + (summary?.bySeverity.info ?? 0),
      auditExports: this.#counters.exports,
      auditPasses: this.#counters.passes,
      auditLivePasses: this.#counters.livePasses,
      auditWatching: this.watching,
      auditHighlightVisible: this.#highlighter.visible,
      auditStaleDiscarded: this.#counters.staleDiscarded,
    };
  }
}
