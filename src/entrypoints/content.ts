import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { AUDIT_PORT_NAME, type AuditPortMessage } from '@core/audit';
import { AuditController } from '@features/audit';
import { createDynamicContentController } from '@features/dynamic-analysis';
import { analyzerOptionsForMode } from '@features/page-analysis';
import { resolveEffectiveSettings } from '@features/settings';
import { getHostname } from '@infrastructure/browser';
import { registerMessageRouter, sendToBackground } from '@infrastructure/messaging';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  main() {
    // The E2E build runs the analyzer on a logical clock (docs/DEVELOPMENT.md); every other build,
    // the shipped one included, uses the real clock.
    const mode = (import.meta as unknown as { env?: { MODE?: string } }).env?.MODE;
    const controller = createDynamicContentController(document, analyzerOptionsForMode(mode));
    const getEffectiveSettings = async () =>
      resolveEffectiveSettings(
        await sendToBackground('GET_SETTINGS', undefined),
        getHostname(location.href),
      );

    // The developer audit (M9): read-only, on demand, and independent of whether adaptation is on.
    const audit = new AuditController({
      doc: document,
      sources: () => controller.auditSources(),
      extensionVersion: browser.runtime.getManifest().version,
    });

    registerMessageRouter({
      ANALYZE_PAGE: async () => controller.analyze(location.href, await getEffectiveSettings()),
      GET_ANALYSIS: () => Promise.resolve(controller.getLastAnalysis()),
      ENABLE_ADAPTATION: async () =>
        controller.enableAdaptation(location.href, await getEffectiveSettings()).adaptation,
      DISABLE_ADAPTATION: () => {
        controller.disableAdaptation();
        return Promise.resolve(null);
      },
      REFRESH_ADAPTATION: async () =>
        controller.enableAdaptation(location.href, await getEffectiveSettings()).adaptation,
      GET_DYNAMIC_DIAGNOSTICS: () => Promise.resolve(controller.dynamic.diagnostics()),
      FLUSH_DYNAMIC: () => Promise.resolve(controller.dynamic.flush()),
      AUDIT_RUN: async (request) => audit.run(await getEffectiveSettings(), request),
      AUDIT_GET: () => Promise.resolve(audit.snapshot),
      AUDIT_HIGHLIGHT: (request) => Promise.resolve(audit.highlight(request)),
      AUDIT_CLEAR_HIGHLIGHT: () => {
        audit.clearHighlight();
        return Promise.resolve(null);
      },
      AUDIT_CLOSE: () => {
        audit.close();
        return Promise.resolve(null);
      },
      AUDIT_NOTE_EXPORT: () => {
        audit.noteExport();
        return Promise.resolve(null);
      },
      AUDIT_DIAGNOSTICS: () => Promise.resolve(audit.diagnostics()),
      AUDIT_SEMANTIC_CASES: (request) => Promise.resolve(audit.semanticCases(request)),
    });

    // An open audit page holds a port: while it is open the audit re-runs when the page changes, and
    // when the page closes (or navigates away) the port drops, which ends the session and the highlight.
    browser.runtime.onConnect.addListener((port) => {
      if (port.name !== AUDIT_PORT_NAME) return;
      audit.open((snapshot) => {
        const message: AuditPortMessage = { type: 'snapshot', generation: snapshot.generation };
        try {
          port.postMessage(message);
        } catch {
          audit.close();
        }
      });
      port.onDisconnect.addListener(() => audit.close());
    });

    void getEffectiveSettings().then((settings) => {
      if (settings.enabled) {
        controller.enableAdaptation(location.href, settings);
      }
    });
  },
});
