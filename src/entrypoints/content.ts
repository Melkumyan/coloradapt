import { defineContentScript } from 'wxt/utils/define-content-script';
import { createDynamicContentController } from '@features/dynamic-analysis';
import { resolveEffectiveSettings } from '@features/settings';
import { getHostname } from '@infrastructure/browser';
import { registerMessageRouter, sendToBackground } from '@infrastructure/messaging';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  main() {
    const controller = createDynamicContentController(document);
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
