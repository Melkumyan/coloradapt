import { useState, type JSX } from 'react';
import { parseLoopbackEndpoint } from '@core/semantic-ai/endpoint';
import { VISION_PROFILE_INFO, VISION_PROFILES } from '@domain/models';
import type { SemanticAIProviderSetting, UserSettings, VisionProfile } from '@domain/models';
import { useSettings } from '@features/settings';

/** The endpoint field: only a loopback address is ever saved; anything else is explained and kept out. */
function EndpointField({
  value,
  onSave,
}: {
  value: string;
  onSave: (endpoint: string) => void;
}): JSX.Element {
  const [text, setText] = useState(value);
  const parsed = parseLoopbackEndpoint(text);
  return (
    <>
      <label htmlFor="options-ai-endpoint">Local model address</label>
      <input
        id="options-ai-endpoint"
        type="text"
        inputMode="url"
        spellCheck={false}
        value={text}
        aria-invalid={!parsed.ok}
        aria-describedby="options-ai-endpoint-hint"
        onChange={(event) => {
          setText(event.target.value);
          const next = parseLoopbackEndpoint(event.target.value);
          if (next.ok) onSave(next.origin);
        }}
      />
      <p
        id="options-ai-endpoint-hint"
        className="options__hint"
        role={parsed.ok ? undefined : 'alert'}
      >
        {parsed.ok
          ? 'Saved. Only this computer’s own loopback address is ever contacted.'
          : 'Not saved: only http://127.0.0.1:<port> or http://localhost:<port> (port 1024 or higher) are accepted.'}
      </p>
    </>
  );
}

function AIProviderField({
  settings,
  update,
}: {
  settings: UserSettings;
  update: (patch: Partial<UserSettings>) => Promise<boolean>;
}): JSX.Element {
  return (
    <>
      <label htmlFor="options-ai-provider">Local runtime</label>
      <select
        id="options-ai-provider"
        value={settings.semanticAIProvider}
        onChange={(event) =>
          void update({ semanticAIProvider: event.target.value as SemanticAIProviderSetting })
        }
      >
        <option value="local-ollama">Ollama</option>
        <option value="local-http">
          ColorAdapt local protocol (see docs/AI_PROVIDER_PROTOCOL.md)
        </option>
      </select>
      <EndpointField
        value={settings.semanticAIEndpoint}
        onSave={(endpoint) => void update({ semanticAIEndpoint: endpoint })}
      />
      <label htmlFor="options-ai-model">Model name</label>
      <input
        id="options-ai-model"
        type="text"
        spellCheck={false}
        defaultValue={settings.semanticAIModel}
        maxLength={60}
        onBlur={(event) => {
          const model = event.target.value.trim();
          if (/^[A-Za-z0-9_.:/-]{0,60}$/.test(model)) void update({ semanticAIModel: model });
        }}
      />
    </>
  );
}

export function App(): JSX.Element {
  const { settings, loading, failed, update } = useSettings();

  if (failed && !settings) {
    return (
      <main className="options">
        <p role="alert">
          ColorAdapt could not load its settings. Close this tab and open it again.
        </p>
      </main>
    );
  }

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
        <label className="options__checkbox">
          <input
            type="checkbox"
            checked={settings.adaptSVG}
            onChange={(event) => void update({ adaptSVG: event.target.checked })}
          />
          Adapt inline SVG icons and text
        </label>
        <label className="options__checkbox">
          <input
            type="checkbox"
            checked={settings.semanticCuesEnabled}
            onChange={(event) => void update({ semanticCuesEnabled: event.target.checked })}
          />
          Add a second cue where color alone carries a state (✓ × ! underline)
        </label>
        <label className="options__checkbox">
          <input
            type="checkbox"
            checked={settings.adaptCharts}
            onChange={(event) => void update({ adaptCharts: event.target.checked })}
          />
          Make chart series distinguishable without color (line styles, markers, patterns)
        </label>
        <label className="options__checkbox">
          <input
            type="checkbox"
            checked={settings.adaptImages}
            onChange={(event) => void update({ adaptImages: event.target.checked })}
          />
          Adapt functional images (small single-color bitmap icons only; photos, logos, screenshots
          and charts are never changed)
        </label>
      </section>

      <section aria-labelledby="ai-heading" className="options__section">
        <h2 id="ai-heading">AI-assisted review (local, optional)</h2>
        <p className="options__hint">
          Off by default. When on, the developer audit gets a “Run AI-assisted review” button that
          asks a model running on this computer to suggest a meaning for findings that need manual
          review. It is advisory: it never changes a finding, never changes a page, and does not
          touch how ColorAdapt adapts pages. There is no cloud option and no fallback to one.
        </p>
        <label className="options__checkbox">
          <input
            type="checkbox"
            checked={settings.semanticAIEnabled}
            onChange={(event) => void update({ semanticAIEnabled: event.target.checked })}
          />
          Enable AI-assisted review in the developer audit
        </label>
        {settings.semanticAIEnabled && <AIProviderField settings={settings} update={update} />}
        <p className="options__hint">
          Only small, redacted summaries of the findings that need review are sent, only to the
          address above, only when you press the button. Form values, URLs, cookies and full page
          text are never included, but a few short visible labels of the elements being asked about
          can be (a label may contain personal text such as a name). In Firefox the browser asks for
          your permission the first time you press the button, and you can withdraw it in the
          add-on’s permissions. Your local runtime must allow requests from this extension (for
          Ollama: set OLLAMA_ORIGINS to include chrome-extension://* in Chrome, or moz-extension://*
          in Firefox).
        </p>
      </section>

      <section aria-labelledby="sites-heading" className="options__section">
        <h2 id="sites-heading">Site Profiles</h2>
        {siteEntries.length === 0 ? (
          <p className="options__hint">
            No per-site settings are stored. Settings apply to every site.
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
          ColorAdapt analyzes pages in your browser and sends nothing to any Internet service: no
          telemetry, no analytics, no account. Your settings stay in this browser. The one optional
          exception is the AI-assisted review above, which is off by default and talks only to a
          model runtime on this computer. See the Privacy document in the project repository for
          details.
        </p>
      </section>

      <section aria-labelledby="about-heading" className="options__section">
        <h2 id="about-heading">About</h2>
        <p className="options__hint">
          ColorAdapt is a local-first browser extension that helps make the web more usable for
          people with color vision deficiencies. Simulations are estimates for accessibility
          purposes, not a medical model of vision.
        </p>
      </section>
    </main>
  );
}
