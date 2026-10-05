import { afterEach } from 'vitest';
import type { AuditSnapshot } from '@core/audit';
import { DEFAULT_USER_SETTINGS, type UserSettings } from '@domain/models';
import { AuditController, type AuditScheduler } from '@features/audit';
import { createDynamicContentController } from '@features/dynamic-analysis';
import type { DynamicContentController } from '@features/dynamic-analysis';
import type { ChartEnvironment } from '@features/charts';
import type { ImageEnvironment } from '@features/images';
import { createManualScheduler } from '../dynamic/helpers';
import { simulatedBrowser } from '../semantics/kit';
import { createFakeEngine, installFakeComputedStyle } from '../../core/svg/fake-engine';

export { simulatedBrowser };

export const DEUTAN: UserSettings = {
  ...DEFAULT_USER_SETTINGS,
  visionProfile: 'deuteranopia',
  adaptationStrength: 1,
};

/** Adaptation switched off: the page is shown as authored; the audit still works. */
export const OFF: UserSettings = { ...DEUTAN, enabled: false };

export const URL_OF_PAGE = 'https://example.test/account?token=SECRET#private';

export interface ManualAuditScheduler extends AuditScheduler {
  readonly pending: number;
  /** Runs the timer that is waiting, if any. */
  fire(): void;
}

export function manualAuditScheduler(): ManualAuditScheduler {
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    setTimeout(callback) {
      const handle = next;
      next += 1;
      timers.set(handle, callback);
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
    get pending() {
      return timers.size;
    },
    fire() {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, run] of due) run();
    },
  };
}

export interface Rig {
  readonly content: DynamicContentController;
  readonly audit: AuditController;
  readonly audited: ManualAuditScheduler;
  readonly dynamicScheduler: ReturnType<typeof createManualScheduler>;
  /** One audit pass with `settings` (the rig's by default). */
  run(scope?: 'auto' | 'active' | 'major'): AuditSnapshot;
  settings: UserSettings;
  /** Changes the address the audit sees (an SPA route change). */
  setUrl(url: string): void;
  /** Times the page layers were read for an audit pass. */
  readonly reads: () => number;
  /** Applies adaptation with the rig's settings (what a page with ColorAdapt ON looks like). */
  adapt(): void;
}

export interface RigOptions {
  readonly css?: string;
  readonly settings?: UserSettings;
  readonly chartEnv?: ChartEnvironment;
  readonly imageEnv?: ImageEnvironment;
  /** Compute SVG paint with the fake CSS engine (jsdom knows no `fill` inheritance). */
  readonly svgEngine?: boolean;
  /** Elements one pass may analyze (default: the product's budget). */
  readonly auditMaxElements?: number;
  /** Turn adaptation on before auditing (default: off, the audit-only path). */
  readonly adapt?: boolean;
  readonly now?: () => number;
  readonly url?: string;
}

let teardowns: Array<() => void> = [];

afterEach(() => {
  for (const stop of teardowns) stop();
  teardowns = [];
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.body.removeAttribute('style');
});

/** Mounts `markup`, builds the controllers as the content script does, and an audit controller on top. */
export function mountAudit(markup: string, options: RigOptions = {}): Rig {
  document.head.innerHTML = options.css ? `<style id="page-css">${options.css}</style>` : '';
  document.body.innerHTML = markup;
  const dynamicScheduler = createManualScheduler();
  let analyzer: Parameters<typeof createDynamicContentController>[1] = { now: () => 0 };
  if (options.svgEngine) {
    const engine = createFakeEngine(document);
    const restore = installFakeComputedStyle(engine);
    teardowns.push(restore);
    analyzer = { now: () => 0, getStyle: engine.getStyle, probeStyles: engine.env.probe };
  }
  const content = createDynamicContentController(
    document,
    analyzer,
    { scheduler: dynamicScheduler },
    {
      env: simulatedBrowser(document),
      ...(options.chartEnv ? { chartEnv: options.chartEnv } : {}),
      ...(options.imageEnv ? { imageEnv: options.imageEnv } : {}),
    },
  );
  const audited = manualAuditScheduler();
  let tick = 1_700_000_000_000;
  let url = options.url ?? URL_OF_PAGE;
  let reads = 0;
  const audit = new AuditController({
    doc: document,
    sources: () => {
      reads += 1;
      return content.auditSources(
        options.auditMaxElements === undefined ? {} : { maxElements: options.auditMaxElements },
      );
    },
    extensionVersion: '0.1.0',
    now: options.now ?? (() => (tick += 1)),
    scheduler: audited,
    url: () => url,
  });
  teardowns.push(() => {
    audit.close();
    content.dynamic.dispose();
    content.disableAdaptation();
  });
  const rig: Rig = {
    content,
    audit,
    audited,
    dynamicScheduler,
    settings: options.settings ?? DEUTAN,
    setUrl: (next) => {
      url = next;
    },
    reads: () => reads,
    run: (scope = 'auto') => audit.run(rig.settings, { scope }),
    adapt: () => {
      content.enableAdaptation(url, rig.settings);
    },
  };
  if (options.adapt) rig.adapt();
  return rig;
}

export const $ = (selector: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`no element matches ${selector}`);
  return node;
};

/** Finding of `ruleId`, or undefined. */
export function findingsOf(snapshot: AuditSnapshot, ruleId: string) {
  return snapshot.findings.filter((finding) => finding.ruleId === ruleId);
}

/** A stable, order-independent description of what an audit found, minus what adaptation changes. */
export function sourceFingerprint(snapshot: AuditSnapshot): string[] {
  return snapshot.findings
    .map((finding) =>
      JSON.stringify({
        id: finding.id,
        rule: finding.ruleId,
        severity: finding.severity,
        confidence: finding.confidence,
        assessment: finding.assessment,
        count: finding.affectedCount,
        profiles: finding.visionProfiles,
        evidence: finding.evidence,
        paths: finding.affected.map((a) => a.locator.path),
      }),
    )
    .sort();
}
