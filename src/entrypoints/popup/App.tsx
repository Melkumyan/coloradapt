import { useCallback, useState, type JSX } from 'react';
import { browser } from 'wxt/browser';
import { VISION_PROFILE_INFO, VISION_PROFILES } from '@domain/models';
import type { AdaptationPlan, UserSettings, VisionProfile } from '@domain/models';
import { useSettings } from '@features/settings';
import { usePageAnalysis } from '@features/page-analysis';
import { getActiveTabId, sendToTab } from '@infrastructure/messaging';

export function App(): JSX.Element {
  const { settings, loading, update } = useSettings();
  const { analysis, analyzing, error, analyze } = usePageAnalysis();
  const [plan, setPlan] = useState<AdaptationPlan | null>(null);

  const toggleEnabled = useCallback(async () => {
    if (!settings) return;
    const nextEnabled = !settings.enabled;
    await update({ enabled: nextEnabled });

    const tabId = await getActiveTabId();
    if (tabId === undefined) return;
    if (nextEnabled) {
      setPlan(await sendToTab(tabId, 'ENABLE_ADAPTATION', undefined));
    } else {
      await sendToTab(tabId, 'DISABLE_ADAPTATION', undefined);
      setPlan(null);
    }
  }, [settings, update]);

  // Profile/strength changes are saved, then the active tab re-plans from the
  // page's original styles (REFRESH_ADAPTATION never compounds).
  const updateAndRefresh = useCallback(
    async (patch: Partial<UserSettings>) => {
      await update(patch);
      if (!settings?.enabled) return;
      try {
        const tabId = await getActiveTabId();
        if (tabId !== undefined) setPlan(await sendToTab(tabId, 'REFRESH_ADAPTATION', undefined));
      } catch {
        // Page without a content script (e.g. a browser settings page): nothing to refresh.
      }
    },
    [settings, update],
  );

  const openSettings = useCallback(() => {
    void browser.runtime.openOptionsPage();
  }, []);

  // The audit runs in its own tab so it can stay open next to the page it audits; the tab id says which page.
  const openAudit = useCallback(async () => {
    const tabId = await getActiveTabId();
    if (tabId === undefined) return;
    await browser.tabs.create({ url: `${browser.runtime.getURL('/audit.html')}?tabId=${tabId}` });
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
          onChange={(event) =>
            void updateAndRefresh({ visionProfile: event.target.value as VisionProfile })
          }
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
          onChange={(event) =>
            void updateAndRefresh({ adaptationStrength: Number(event.target.value) })
          }
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

      {plan && settings.enabled && (
        <section className="popup__field" aria-label="Adaptation summary">
          <p className="popup__result">
            Adapted: <strong>{plan.summary.adapted}</strong>
            {' · '}Unresolved:{' '}
            <strong>{plan.summary.unresolved + plan.summary.noSafeCandidate}</strong>
            <br />
            <small>
              Problems estimated for this profile: {plan.summary.problemsDetected}. Adjustments are
              model-guided estimates ({plan.confidence}).
            </small>
          </p>
        </section>
      )}

      <footer className="popup__footer">
        <button type="button" className="popup__link-button" onClick={openSettings}>
          Settings
        </button>{' '}
        <button type="button" className="popup__link-button" onClick={() => void openAudit()}>
          Developer audit
        </button>
      </footer>
    </main>
  );
}
