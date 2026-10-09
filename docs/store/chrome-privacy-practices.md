# Chrome Web Store: Privacy practices tab answers

Exact answers for the dashboard's Privacy practices tab. They match the implementation, the privacy policy
(`PRIVACY_POLICY.md`) and the listing (`chrome-listing.md`); the validator fails if the documents drift apart.

The dashboard's own wording of the data categories is not published outside the dashboard; the mapping below uses the
categories as Google's policy names them and must be re-checked against the live form at submission.

## Single purpose

ColorAdapt improves the readability and distinguishability of web interfaces for people with color-vision deficiencies
by adapting color-dependent visual information in the browser.

(Non-color cues, chart differentiation, icon adaptation, the developer audit and its optional local AI assistance are
parts of that one purpose, not separate products.)

## Permission justifications

| Permission                                   | Answer                                                                                                                                                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                                    | Saves the user's settings (profile, strength, switches, optional AI settings) locally so they persist. Nothing else is stored.                                                                                                      |
| Host permissions `http://*/*`, `https://*/*` | Required to inspect and adapt page presentation on websites where the user enables or uses the extension. Processing is local in the browser; page data is not transmitted. Cannot be narrower: the user chooses sites by browsing. |

No other permission is requested: no `tabs`, `activeTab`, `scripting`, `webRequest`, `cookies`, `history`, `downloads`,
`<all_urls>` or optional permissions.

## Remote code

**Does your extension use remote code? No.** All logic is in the package (Manifest V3, `script-src 'self'`); no remote
script, no `eval`/`new Function`, no downloaded WebAssembly or code. Answers from the optional local AI runtime are data
parsed against a closed schema and validated; they cannot become code.

## Data usage

Distinction used throughout: **accessed locally in the browser** (processed on the device by the extension, not sent
anywhere) is different from **transmitted outside the browser**.

| Data type (policy category)         | Accessed locally in the browser                                                                          | Transmitted outside the browser                                                                                                                                                                                            | Collected / retained by the publisher |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Website content                     | Yes: colors, structure and a few attributes of the page the user views, to adapt it                      | **By default no.** Only if the user enables and runs the optional AI-assisted review: a small sanitized semantic summary to a loopback runtime on the user's own computer (`127.0.0.1`/`localhost`). Never to the Internet | No; nothing reaches the publisher     |
| Personally identifiable information | Not read as such. Short visible labels can contain a name; they are processed like other page text       | Only as part of the optional loopback summary above, if present in a short label; no recognizer, no collection                                                                                                             | No                                    |
| Health information                  | No. The selected color-vision profile is a display setting stored locally, not health data sent anywhere | No                                                                                                                                                                                                                         | No                                    |
| Authentication information          | No (form values and passwords are never read)                                                            | No                                                                                                                                                                                                                         | No                                    |
| Financial and payment information   | No                                                                                                       | No                                                                                                                                                                                                                         | No                                    |
| Personal communications             | No                                                                                                       | No                                                                                                                                                                                                                         | No                                    |
| Location                            | No                                                                                                       | No                                                                                                                                                                                                                         | No                                    |
| Web history                         | No (the page address is not stored; no history permission)                                               | No                                                                                                                                                                                                                         | No                                    |
| User activity                       | No (no clicks, keystrokes, scrolls or analytics recorded)                                                | No                                                                                                                                                                                                                         | No                                    |

**Recommended checkbox decision for the first group:** tick **Website content** only, and explain it in the privacy
policy as the optional local AI summary. Rationale: the policy asks for disclosure of data the extension handles; the
default path transmits nothing, but disclosing the optional path is the cautious, accurate choice and matches Firefox's
`websiteContent` declaration. Leave every other box unticked.

Data retained: none outside the user's own browser (settings in `storage.local`).
Data sold or transferred to third parties: none. Data used for advertising, creditworthiness or unrelated purposes: none.
Analytics: none.

## Certifications (second group)

All three can be certified truthfully:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

Limited Use notes: the only handling beyond local processing is the optional loopback summary, used solely to show the
user an advisory interpretation of an audit finding; it is not stored, not shared and not used for anything else.

## Privacy policy

PUBLIC_PRIVACY_POLICY_URL: **REQUIRED_EXTERNALLY**. Host `docs/store/PRIVACY_POLICY.md` at a public address the publisher
controls and enter it here and on the developer account page; the policy must stay consistent with these answers.

## Consistency statement

What the package does, what the permissions say, what the privacy policy says and what the listing says agree:
nothing is sent to external services by default; the only optional transmission is a bounded, sanitized summary to a
local loopback runtime that the user installs and enables.
