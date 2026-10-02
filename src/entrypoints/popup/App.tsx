import { useCallback, type JSX } from 'react';
import { browser } from 'wxt/browser';
import { VISION_PROFILE_INFO, VISION_PROFILES } from '@domain/models';
import type { VisionProfile } from '@domain/models';
import { useSettings } from '@features/settings';
import { usePageAnalysis } from '@features/page-analysis';
import { getActiveTabId, sendToTab } from '@infrastructure/messaging';

export function App(): JSX.Element {
  const { settings, loading, update } = useSettings();
  const { analysis, analyzing, error, analyze } = usePageAnalysis();

  const toggleEnabled = useCallback(async () => {
    if (!settings) return;
    const nextEnabled = !settings.enabled;
    await update({ enabled: nextEnabled });

    const tabId = await getActiveTabId();
    if (tabId === undefined) return;
    if (nextEnabled) {
      await sendToTab(tabId, 'ENABLE_ADAPTATION', undefined);
    } else {
      await sendToTab(tabId, 'DISABLE_ADAPTATION', undefined);
    }
  }, [settings, update]);

  const openSettings = useCallback(() => {
    void browser.runtime.openOptionsPage();
  }, []);

  if (loading || !settings) {
    return (
      <main className="popup" aria-busy="true">
        <p>Loading…</p>
      </main>
    );
  }

  return (
    <main className="popup">
      <header className="popup__header">
        <h1>ColorAdapt</h1>
      </header>

      <section className="popup__field" aria-labelledby="protection-label">
        <span id="protection-label" className="popup__label">
          Protection
        </span>
        <button
          type="button"
          className={`popup__toggle ${settings.enabled ? 'popup__toggle--on' : 'popup__toggle--off'}`}
          aria-pressed={settings.enabled}
          onClick={() => void toggleEnabled()}
        >
          {settings.enabled ? 'ON' : 'OFF'}
        </button>
      </section>

      <section className="popup__field">
        <label htmlFor="vision-profile" className="popup__label">
          Vision profile
        </label>
        <select
          id="vision-profile"
          value={settings.visionProfile}
          onChange={(event) => void update({ visionProfile: event.target.value as VisionProfile })}
        >
          {VISION_PROFILES.map((profile) => (
            <option key={profile} value={profile}>
              {VISION_PROFILE_INFO[profile].label}
            </option>
          ))}
        </select>
      </section>

      <section className="popup__field">
        <label htmlFor="adaptation-strength" className="popup__label">
          Adaptation strength
        </label>
        <input
          id="adaptation-strength"
          type="range"
          min={0}
          max={1}
          step={0.1}
          value={settings.adaptationStrength}
          onChange={(event) => void update({ adaptationStrength: Number(event.target.value) })}
        />
      </section>

      <section className="popup__field">
        <button type="button" onClick={() => void analyze()} disabled={analyzing}>
          {analyzing ? 'Analysing…' : 'Analyse page'}
        </button>
        {error && (
          <p role="alert" className="popup__error">
            {error}
          </p>
        )}
        {analysis && !error && (
          <p className="popup__result">
            Problems detected: <strong>{analysis.conflicts.length}</strong>
            {analysis.truncated && ' (partial scan — page is very large)'}
            {analysis.unresolvedCount > 0 && (
              <>
                {' '}
                <br />
                <small>
                  {analysis.unresolvedCount} element(s) skipped — background could not be reliably
                  determined (e.g. gradient/image).
                </small>
              </>
            )}
          </p>
        )}
      </section>

      <footer className="popup__footer">
        <button type="button" className="popup__link-button" onClick={openSettings}>
          Settings
        </button>
      </footer>
    </main>
  );
}
