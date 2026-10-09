# Chrome Web Store listing (English)

Dashboard copy, ready to paste. Nothing here has been submitted.

## Store listing tab

**Name:** ColorAdapt

**Summary:** Helps people with color vision deficiencies tell colors apart on the web by adapting page colors and adding non-color cues.

**Category:** Accessibility (verify against the live dashboard list at submission)

**Language:** English (the interface is English only; see `chrome-listing.ru.md` for the Russian store text)

**Detailed description:**

```text
ColorAdapt helps people with color vision deficiencies read and tell apart the colors used on web pages.

Pick the color-vision profile that matches you (protanopia, protanomaly, deuteranopia, deuteranomaly, tritanopia,
tritanomaly, achromatopsia or a custom profile). ColorAdapt looks at the colors on the page you are viewing,
estimates which text and interface colors are hard to tell apart for that profile, and changes only those colors by
the smallest amount that helps. Turn it off and the page returns exactly as the site made it.

What it does
• Adapts text and interface colors that are hard to distinguish for your profile, leaving the rest of the page alone.
• Adds small non-color cues where color alone carries a state, for example a check or warning mark next to a success
  or error message, when the page's own markup makes the state clear.
• Helps tell chart series apart with line styles, markers and patterns in supported SVG charts.
• Adapts single-color icons (inline SVG, and optional small image icons).
• Developer audit: a read-only report of color-dependent problems on a page, with the evidence, that you can export.
• Optional, off by default: AI-assisted review of audit findings that need a human decision, using a language model
  running on your own computer.

Your privacy
• By default ColorAdapt sends no page data to external services. No telemetry, no analytics, no ads, no account.
• Settings are saved in your browser.
• The optional AI-assisted developer review is disabled by default. When you enable and run it, ColorAdapt may send a
  small sanitized semantic context to a local loopback AI runtime on your computer (for example Ollama). It has no
  cloud fallback and needs a separately installed local runtime.

Please note
• Color adaptation is an estimate based on common color-vision models; it is not a medical tool and cannot restore
  color vision or replace professional advice.
• Complex graphics and some pages may remain unchanged, and some cases are left for manual review. ColorAdapt does
  not make a page WCAG-compliant and is not a conformance checker.
• The interface is currently in English.
• ColorAdapt needs access to the websites you use in order to adapt them.
```

**Screenshots (1280x800):** `release/m13/assets/screenshot-01.png` to `screenshot-05.png` (captions in `docs/store/REVIEWER_GUIDE.md`, section "Screenshots").

**Small promo tile (440x280):** `release/m13/assets/promo-440x280.png`. **Marquee (1400x560):** not provided (optional). **Video:** PROMO_VIDEO NOT PROVIDED.

**Store icon (128x128):** `release/m13/assets/icon-128.png`.

**Support:** URL or email supplied by the publisher at submission (EXTERNAL_SUBMISSION_REQUIREMENT).

## Privacy tab

**Single purpose:**

```text
ColorAdapt improves the readability and distinguishability of web interfaces for people with color-vision deficiencies by adapting color-dependent visual information in the browser.
```

The other capabilities (non-color cues, chart differentiation, icon adaptation, the developer audit and its optional
local AI assistance) are parts of that one purpose.

### Permission justifications

| Permission                                     | Justification (paste)                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                                      | Saves the user's own settings (selected color-vision profile, strength, on/off switches, optional AI settings) in the browser so they persist. Nothing else is stored.                                                                                                                                                                                                       |
| Host permissions (`http://*/*`, `https://*/*`) | ColorAdapt must inspect and adapt page presentation on websites where the user enables or uses the extension. A content script reads the page's colors and structure locally and adds a reversible stylesheet. The user cannot know in advance which sites they will need, so access is not limited to a list. Page data is processed in the browser and is not transmitted. |

### Remote code

**No, this extension does not use remote code.** All code ships in the package; there is no `eval`, no remotely hosted
script and no downloaded WebAssembly. Manifest V3, `script-src 'self'`. The optional AI feature sends a bounded
structured query to a loopback runtime on the user's computer and parses the reply as validated data; it is never
executed.

### Data usage and certifications

See `chrome-privacy-practices.md` for the checkbox answers, the policy link requirement and the certifications.

**Privacy policy URL:** PUBLIC_PRIVACY_POLICY_URL = REQUIRED_EXTERNALLY (publish `docs/store/PRIVACY_POLICY.md`).

## Test instructions tab

No account, password, key or paid service is needed. Reviewer steps are in `docs/store/REVIEWER_GUIDE.md`; paste:

```text
No login is required. 1) Install the extension. 2) Open any web page (a local test page is described in the reviewer
guide). 3) Click the ColorAdapt toolbar button, choose "Deuteranopia" and turn Protection on. 4) Colors that are hard
to tell apart for that profile are adapted; turn it off to restore the page. 5) Click "Developer audit" in the popup to
see the read-only report. The optional AI-assisted review is off by default, is not bundled, needs no key, and is not
required to review the extension. It can only reach a runtime on 127.0.0.1 or localhost.
```

## Reviewer notes (for the "notes to reviewer" field)

- **Single purpose:** as above; all features serve it.
- **Broad site access:** needed because the core function adapts the page the user is on, on any site; processing is
  local.
- **Local-only processing:** page data is read and processed in the browser; no telemetry, analytics or cloud backend.
- **Optional loopback AI:** off by default, user-initiated, loopback (`127.0.0.1`/`localhost`) only, no cloud fallback,
  no bundled model; replies are validated data and never executed; advisory only.
- **No remote executable code:** Manifest V3, `script-src 'self'`, 0 `eval`/`new Function`/remote scripts.
- **No telemetry.**
