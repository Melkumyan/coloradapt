# ColorAdapt Privacy Policy

_Version 0.1.0. Applies to the ColorAdapt browser extension for Google Chrome and Mozilla Firefox._

ColorAdapt helps people with color-vision deficiencies read and distinguish web pages. To do that it has to look at the
pages you visit. This policy says what it looks at, what it keeps, and the one optional feature that can pass
information to software on your own computer.

## In short

- By default, ColorAdapt sends no page data to external services.
- No telemetry, no analytics, no advertising, no accounts, no sale or sharing of data, no cloud backend.
- Your settings stay in your browser's local extension storage.
- The optional AI-assisted developer review is **disabled by default**. When you explicitly enable and run it,
  ColorAdapt may send a small sanitized semantic context to a local loopback AI runtime configured on your computer.
  ColorAdapt has **no cloud AI fallback**.

## What ColorAdapt accesses, and why

ColorAdapt requests access to websites (`http://*/*` and `https://*/*`) because it must inspect and adapt page
presentation on the websites where you enable or use it. In the page, in your browser, it reads the structure,
computed colors and a few attributes of elements (for example ARIA state, form-control state, image sizes) in order to
decide which color combinations are hard to tell apart and what to change. It adds a stylesheet and, in supported
cases, small non-color cues to the page, and removes them when you turn ColorAdapt off. This processing happens in your
browser. The page data it reads is not stored. By default none of it is transmitted; the single exception is the
optional, off-by-default AI-assisted review described below, which can send a small sanitized part of it to a
model runtime on your own computer.

## What is stored

- **Settings** (the selected color-vision profile, strength, on/off switches, the optional
  AI settings) in `storage.local`, which stays in your browser profile. If you enable your browser's own sync, that
  browser's terms apply to it; ColorAdapt adds nothing.
- **Nothing else.** No page content, no browsing history, no audit results, no AI prompts or answers are written to
  storage. Developer-audit reports and exports exist in memory (and in a file only if you save one) and are gone when
  the audit page closes.
- One line of diagnostic text may be written to your browser's developer console when something recovers or fails
  (an error code, never a page's content). It is never sent anywhere.

## No telemetry, analytics, ads or sale of data

ColorAdapt contains no analytics, crash-reporting, advertising or tracking code, makes no request to any ColorAdapt
server (there is none), and does not sell, rent or share user data with anyone.

## The optional local AI-assisted review

The developer audit can, if you turn it on in the extension's settings and then press **Run AI-assisted review**, ask a
language-model runtime that you run on your own computer (for example Ollama) what a finding that needs manual review
may mean. It is advisory only: it cannot change a finding or a page.

- **Disabled by default.** An update never turns it on. ColorAdapt works the same without it.
- **Where it can send:** only to `http://127.0.0.1:<port>` or `http://localhost:<port>` on your computer. The browser
  enforces this in the extension's content security policy as well as the code. No other host, no LAN address, no
  Internet address, no redirect is followed.
- **What it sends,** per finding, a small bounded summary: element type and role, a few accessibility state values, a
  bounded accessible name, up to five nearby short labels, names of a few sibling elements, and the deterministic
  evidence the audit found. Text passes redaction (email addresses, long numbers, opaque tokens and invisible
  characters are removed). A short visible label can still be personal text, such as a person's name; ColorAdapt
  cannot recognize that, so do not run the review on a page whose short labels you do not want your local runtime to
  see.
- **What it never sends:** the value or text of any form field or editable area, passwords, URLs, the page address,
  ids, class names, `data-` attributes, cookies, storage, headers, HTML, the page's full text, hidden text, images or
  screenshots.
- **Storage:** none. Prompts, answers and cache are in memory and discarded when you close the audit page, turn the
  setting off, or change the page or provider.
- **Firefox:** Firefox counts this as data leaving the add-on, so the add-on declares the optional data-collection
  permission `websiteContent` and Firefox itself asks you the first time you press the button. If you decline, nothing
  is sent and the rest of ColorAdapt works as before. You can withdraw the permission at any time in the add-on's
  permissions page; ColorAdapt then stops, cancels what is running and sends nothing further. Firefox 140 or later is
  required.
- **Chrome:** Chrome has no equivalent prompt; the setting that is off by default, the explicit button and this
  disclosure are the consent.
- **The runtime is separate software.** What it does with a request (logging, forwarding, showing) is outside
  ColorAdapt's control and governed by its own terms. Use one you trust. ColorAdapt does not install, bundle or
  configure a runtime and ships no model.

## Images

The optional image layer (off by default) reads the pixels of images that the page already displays, in your browser,
to recolor a few kinds of single-color icons. To read them it may request the same image again from the page's own
site (same origin, or an image the page loads with CORS), exactly as the page could. Pixels and the generated bitmaps
are not uploaded or stored.

## Permissions and revocation

- `storage` keeps your settings. Website access (`http://*/*`, `https://*/*`) lets the extension run on the pages you
  visit. Nothing else is requested; there is no access to your history, tabs list, cookies, downloads or bookmarks.
- You can remove ColorAdapt at any time; as browsers do for every extension, the browser then deletes the extension's
  stored settings. You can reset the settings by removing and reinstalling it. Data held by a separate AI runtime you
  installed is not removed by this.

## Children

ColorAdapt does not collect personal information from anyone, children included.

## Changes

If a future version changes what is described here, this policy and the store listing change with it, and any new
data transmission would be opt-in, off by default and never required for the extension to work.

## Contact

The publisher's support route is given on the store listing page for ColorAdapt. This repository contains no contact
address.
