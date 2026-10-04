import { defineContentScript } from 'wxt/utils/define-content-script';
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
    });

    void getEffectiveSettings().then((settings) => {
      if (settings.enabled) {
        controller.enableAdaptation(location.href, settings);
      }
    });
  },
});
