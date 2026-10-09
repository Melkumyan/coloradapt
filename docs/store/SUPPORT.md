# ColorAdapt support

## How to report a problem

Use the support route on the store listing page for ColorAdapt (the publisher provides it; this repository does not
carry a contact address). Please include: the browser and its version, the ColorAdapt version (shown in the browser's
extension page), the color-vision profile you selected, the address of a page where it happens if it is public, and what
you expected. **Do not send screenshots or reports of pages that show personal information.** A developer-audit export
contains element locators and short redacted text snippets; read it before you share it.

## Supported browsers

- Google Chrome (desktop), current stable. Tested with Chrome 154 on Windows 11.
- Mozilla Firefox (desktop) **140 or later**. Tested with Firefox 151 on Windows 11. Older Firefox cannot install it.

Other Chromium browsers and Firefox for Android are not tested and not supported.

## Basic troubleshooting

- **Nothing changes on a page.** Open the toolbar popup: Protection must be ON and the vision profile must not be
  "Normal vision" (that profile adapts nothing). Reload the page after changing the profile on a page opened before
  you installed the extension. ColorAdapt does not run on browser pages (`chrome://`, `about:`), the extension stores'
  pages, local `file://` pages or pages your browser blocks extensions from.
- **A page looks the same as before in some places.** ColorAdapt is deliberately conservative: it changes only colors it
  is confident about and leaves photographs, logos, gradients, complex graphics and uncertain cases alone.
- **I want the original page back.** Turn Protection off in the popup; the page returns to what the site made it. Reload
  if a page was already open when the browser updated the extension (Firefox keeps its old styling until the tab reloads).
- **Settings do not load.** The popup says so and the page stays unadapted; close and reopen the popup, or restart the
  browser. If it persists, remove and reinstall the extension (this resets the settings).
- **Charts or icons are unchanged.** Only simple inline-SVG charts with a clear legend, and single-color icons, are
  adapted. Canvas charts, heatmaps and stacked areas are reported by the developer audit but left alone.

## Optional AI-assisted review (Ollama and similar)

The AI-assisted review is **optional, off by default and not needed** for anything else in ColorAdapt. It requires a
language-model runtime that you install and run yourself on your own computer; ColorAdapt does not include one and has
no cloud option.

1. Install a runtime such as [Ollama](https://ollama.com) and pull a model.
2. Allow requests from the extension: for Ollama set the environment variable `OLLAMA_ORIGINS` to include
   `chrome-extension://*` (Chrome) or `moz-extension://*` (Firefox; Firefox gives every installation a random
   internal address, so the wildcard is the correct form), then restart Ollama.
3. In ColorAdapt's settings turn on "Enable AI-assisted review in the developer audit", choose the provider, keep the
   address `http://127.0.0.1:11434` (or the `localhost` form; **only `127.0.0.1` and `localhost` with a port are
   accepted; the IPv6 address `[::1]` is not**), and enter the model name.
4. Open the developer audit and press **Run AI-assisted review**. In Firefox the browser asks for your permission the
   first time; you can withdraw it later in the add-on's permissions.

If it says the local AI is unavailable: the runtime is not running or not at that address; a firewall or a wrong port;
`OLLAMA_ORIGINS` is not set (the runtime answers 403); or the model name is wrong. Nothing was sent anywhere else, and the
manual-review findings are unchanged. The review never changes a finding or a page.

## Known limitations

- Adaptation is an estimate based on common color-vision models. It is not a medical tool and does not restore color
  vision or replace professional advice.
- Some complex graphics, canvas charts, photographs and uncertain cases remain unchanged, and some findings are left for
  manual review. ColorAdapt does not make a page WCAG-compliant.
- The interface is in English only.
- In Firefox, after the extension updates or reloads, a page that was already open keeps its previous adaptation until you
  reload the tab.
- Very large page updates (thousands of elements at once) may take a moment to finish adapting.
- On rare occasions Firefox cannot read the extension's settings at start; ColorAdapt then leaves the page unadapted and
  tells you, instead of changing anything.

## Privacy and support route

See `PRIVACY_POLICY.md`. ColorAdapt sends no telemetry, so support never needs your data: you decide what, if anything,
to share.
