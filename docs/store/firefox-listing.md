# Mozilla Add-ons (AMO) listing (English)

Copy for the AMO developer hub. Nothing here has been submitted.

**Name:** ColorAdapt

**Summary:** Helps people with color vision deficiencies tell colors apart on the web: adapts page colors and adds non-color cues. Local-first, no telemetry.

**Categories:** Accessibility (primary); Appearance. Verify the exact category names in the developer hub at submission.

**Add-on id:** `coloradapt@melkumyan` (owner decision, permanent). ID_SYNTAX: PASS. ID_AMO_UNIQUENESS: EXTERNAL_VERIFICATION_REQUIRED (known only at first upload).

**Minimum Firefox version:** 140.0 (desktop). Not declared for Firefox for Android.

**License:** "All Rights Reserved" / custom license: choose the custom-license option and paste the text of `LICENSE` (Proprietary, All Rights Reserved). Verify the exact option wording in the developer hub at submission.

## Description

```text
ColorAdapt helps people with color vision deficiencies read and tell apart the colors used on web pages.

Choose the color-vision profile that matches you (protanopia, protanomaly, deuteranopia, deuteranomaly, tritanopia,
tritanomaly, achromatopsia or a custom profile). ColorAdapt looks at the colors of the page you are viewing, estimates
which text and interface colors are hard to tell apart for that profile, and changes only those, by the smallest amount
that helps. Turn it off and the page returns as the site made it.

What it does
• Adapts text and interface colors that are hard to distinguish for your profile, leaving the rest of the page alone.
• Adds small non-color cues (a check, a cross, an outline) where color alone carries a state, when the page's markup
  makes the state clear.
• Helps tell chart series apart with line styles, markers and patterns in supported SVG charts.
• Adapts single-color icons (inline SVG, and optional small image icons).
• Developer audit: a read-only report of color-dependent problems on a page, with evidence, exportable.
• Optional, off by default: AI-assisted review of audit findings that need a human decision, using a language model
  that runs on your own computer.

Privacy
• By default ColorAdapt sends no page data to external services. No telemetry, analytics, ads or account.
• Settings are stored in your browser.
• The optional AI-assisted developer review is disabled by default. If you run it, ColorAdapt may send a small
  sanitized semantic context to a local loopback AI runtime on your computer (for example Ollama). Firefox asks for
  your permission first (optional "website content" data permission), you can withdraw it at any time, and nothing is
  sent without it. There is no cloud fallback and no model is bundled.

Please note
• Adaptation is an estimate from common color-vision models. It is not a medical tool and cannot restore color vision.
• Complex graphics and some pages may stay unchanged, and some cases are left for manual review. ColorAdapt does not
  make a page WCAG-compliant.
• The interface is currently in English.
• ColorAdapt needs access to websites in order to adapt them.
```

## Support information

Support route (website, email or issue tracker): supplied by the publisher. EXTERNAL_SUBMISSION_REQUIREMENT. Troubleshooting
text for users: `docs/store/SUPPORT.md`.

## Privacy policy

Public URL: PUBLIC_PRIVACY_POLICY_URL = REQUIRED_EXTERNALLY. Text: `docs/store/PRIVACY_POLICY.md`.

Data collection declared in the manifest: `required: ["none"]`, `optional: ["websiteContent"]`. The optional item is
requested by Firefox's own prompt only when the user presses "Run AI-assisted review".

## Screenshots

Use the five 1280x800 images from `release/m13/assets/` (captions as in the reviewer guide).

## Notes for reviewers

The paste-ready block for the "Notes for Reviewers" field is `docs/store/amo-reviewer-notes.md` (one source, so it cannot
drift from this listing). It states the optional `websiteContent` data-collection permission, the source and build
instructions, and how to test without Ollama.
