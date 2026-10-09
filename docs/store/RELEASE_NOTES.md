# ColorAdapt release notes

## 0.1.0: first public release

ColorAdapt helps people with color-vision deficiencies read and tell apart the colors used on web pages, in Chrome and
Firefox.

**What you can do**

- Pick a color-vision profile (protanopia, protanomaly, deuteranopia, deuteranomaly, tritanopia, tritanomaly,
  achromatopsia, custom) and have text and interface colors that are hard to tell apart adapted, by the smallest change
  that helps. Turn it off and the page is exactly as the site made it.
- See small non-color cues (a check, a cross, a warning mark, an outline) where color alone carried a state.
- Tell chart series apart by line style, marker and pattern in supported SVG charts.
- Have single-color icons (inline SVG, and optionally small image icons) adapted.
- Use the developer audit: a read-only report of color-dependent problems, with evidence and coverage, exportable as JSON
  or a standalone HTML file.
- Optionally (off by default) ask a language model that runs on your own computer to suggest what an audit finding that
  needs manual review may mean. It is advisory only, has no cloud fallback, and needs a separately installed local runtime.

**Privacy**

- No telemetry, no analytics, no ads, no account. By default nothing is sent to external services.
- Settings stay in your browser.
- In Firefox the optional AI review asks for your permission (website content) before anything is sent to the local
  runtime, and you can withdraw it at any time. Firefox 140 or later is required.

**Good to know**

- Adaptation is an estimate based on common color-vision models; it is not a medical tool and does not guarantee
  accessibility or WCAG conformance. Complex graphics and uncertain cases are left unchanged.
- The interface is in English.
- Supported: Chrome desktop (tested on 154) and Firefox desktop 140+ (tested on 151).
