import { type JSX } from 'react';
import { VISION_PROFILE_INFO, VISION_PROFILES } from '@domain/models';
import type { VisionProfile } from '@domain/models';
import { useSettings } from '@features/settings';

export function App(): JSX.Element {
  const { settings, loading, update } = useSettings();

  if (loading || !settings) {
    return (
      <main className="options" aria-busy="true">
        <p>Loading…</p>
      </main>
    );
  }

  const siteEntries = Object.values(settings.siteOverrides);

  return (
    <main className="options">
      <h1>ColorAdapt Settings</h1>

      <section aria-labelledby="general-heading" className="options__section">
        <h2 id="general-heading">General</h2>
        <label className="options__checkbox">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(event) => void update({ enabled: event.target.checked })}
          />
          Enable ColorAdapt
        </label>
        <label className="options__checkbox">
          <input
            type="checkbox"
            checked={settings.showWarnings}
            onChange={(event) => void update({ showWarnings: event.target.checked })}
          />
          Show warnings for detected problems
        </label>
      </section>

      <section aria-labelledby="vision-heading" className="options__section">
        <h2 id="vision-heading">Vision Profile</h2>
        <label htmlFor="options-vision-profile">Default vision profile</label>
        <select
          id="options-vision-profile"
          value={settings.visionProfile}
          onChange={(event) => void update({ visionProfile: event.target.value as VisionProfile })}
        >
          {VISION_PROFILES.map((profile) => (
            <option key={profile} value={profile}>
              {VISION_PROFILE_INFO[profile].label}
            </option>
          ))}
        </select>
        <p className="options__hint">{VISION_PROFILE_INFO[settings.visionProfile].description}</p>
      </section>

      <section aria-labelledby="adaptation-heading" className="options__section">
        <h2 id="adaptation-heading">Adaptation</h2>
        <label htmlFor="options-strength">
          Adaptation strength ({Math.round(settings.adaptationStrength * 100)}%)
        </label>
        <input
          id="options-strength"
          type="range"
          min={0}
          max={1}
          step={0.1}
          value={settings.adaptationStrength}
          onChange={(event) => void update({ adaptationStrength: Number(event.target.value) })}
        />
        <label className="options__checkbox">
          <input
            type="checkbox"
            checked={settings.improveUIColors}
            onChange={(event) => void update({ improveUIColors: event.target.checked })}
          />
          Improve low-contrast UI colors
        </label>
        <label className="options__checkbox">
          <input
            type="checkbox"
            checked={settings.improveLinks}
            onChange={(event) => void update({ improveLinks: event.target.checked })}
          />
          Improve link distinguishability
        </label>
        <label className="options__checkbox">
          <input
            type="checkbox"
            checked={settings.improveStatusIndicators}
            onChange={(event) => void update({ improveStatusIndicators: event.target.checked })}
          />
          Improve status indicators (success/error/warning)
        </label>
        <label className="options__checkbox options__checkbox--planned">
          <input type="checkbox" checked={settings.adaptSVG} disabled />
          Adapt SVG icons <span className="options__badge">planned</span>
        </label>
        <label className="options__checkbox options__checkbox--planned">
          <input type="checkbox" checked={settings.adaptCharts} disabled />
          Adapt charts <span className="options__badge">planned</span>
        </label>
        <label className="options__checkbox options__checkbox--planned">
          <input type="checkbox" checked={settings.adaptImages} disabled />
          Adapt images <span className="options__badge">planned</span>
        </label>
      </section>

      <section aria-labelledby="sites-heading" className="options__section">
        <h2 id="sites-heading">Site Profiles</h2>
        {siteEntries.length === 0 ? (
          <p className="options__hint">
            No per-site overrides yet. Site overrides appear here once configured.
          </p>
        ) : (
          <ul className="options__site-list">
            {siteEntries.map((site) => (
              <li key={site.hostname} className="options__site-item">
                <span>
                  <strong>{site.hostname}</strong> — {VISION_PROFILE_INFO[site.visionProfile].label}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const { [site.hostname]: _removed, ...rest } = settings.siteOverrides;
                    void update({ siteOverrides: rest });
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="privacy-heading" className="options__section">
        <h2 id="privacy-heading">Privacy</h2>
        <p className="options__hint">
          ColorAdapt analyzes pages entirely on your device. No page content, settings, or usage
          data is ever sent to a server. See the Privacy document in the project repository for
          details.
        </p>
      </section>

      <section aria-labelledby="about-heading" className="options__section">
        <h2 id="about-heading">About</h2>
        <p className="options__hint">
          ColorAdapt is an early-stage, local-first browser extension that helps make the web more
          usable for people with color vision deficiencies. Simulations are estimates for
          accessibility purposes, not a medical model of vision.
        </p>
      </section>
    </main>
  );
}
