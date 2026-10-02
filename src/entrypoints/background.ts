import { defineBackground } from 'wxt/utils/define-background';
import { createBrowserStorageBackend, SettingsStore } from '@infrastructure/storage';
import { registerMessageRouter } from '@infrastructure/messaging';

export default defineBackground(() => {
  const settingsStore = new SettingsStore(createBrowserStorageBackend());

  registerMessageRouter({
    GET_SETTINGS: () => settingsStore.get(),
    UPDATE_SETTINGS: (patch) => settingsStore.update(patch),
  });
});
