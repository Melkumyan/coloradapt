import { defineContentScript } from 'wxt/utils/define-content-script';
import { createContentController } from '@features/page-analysis';
import { registerMessageRouter, sendToBackground } from '@infrastructure/messaging';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  main() {
    const controller = createContentController(document);

    registerMessageRouter({
      ANALYZE_PAGE: async () =>
        controller.analyze(location.href, await sendToBackground('GET_SETTINGS', undefined)),
      GET_ANALYSIS: () => Promise.resolve(controller.getLastAnalysis()),
      ENABLE_ADAPTATION: async () => {
        const settings = await sendToBackground('GET_SETTINGS', undefined);
        return controller.enableAdaptation(location.href, settings).adaptation;
      },
      DISABLE_ADAPTATION: () => {
        controller.disableAdaptation();
        return Promise.resolve(null);
      },
      REFRESH_ADAPTATION: async () => {
        const settings = await sendToBackground('GET_SETTINGS', undefined);
        return controller.enableAdaptation(location.href, settings).adaptation;
      },
    });

    void sendToBackground('GET_SETTINGS', undefined).then((settings) => {
      if (settings.enabled) {
        controller.enableAdaptation(location.href, settings);
      }
    });
  },
});
