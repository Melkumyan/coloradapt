# Store submission checklist (owner steps)

Adjust to the dashboards' actual wording at submission time. Upload the **exact** files in `release/m13/` and check their
SHA-256 against `SHA256SUMS`; do not rebuild or edit them. Nothing has been uploaded or submitted. External submission is
blocked until the items in `OWNER_ACCOUNTS.md` and the two public URLs exist (`PUBLIC_URLS_READY: NO`). Stop before the final
Publish/Submit action unless the owner explicitly decides to proceed.

## Chrome Web Store

1. Sign in to the Chrome Web Store developer dashboard.
2. Verify the account and that 2-Step Verification is enabled (`OWNER_ACCOUNTS.md`).
3. Create a new item.
4. Upload `chrome/coloradapt-chrome-0.1.0.zip`.
5. Fill the listing with the prepared EN and RU copy (`chrome-listing.md`, `chrome-listing.ru.md`).
6. Add the icon, the five screenshots and the promo tile from `release/m13/assets/`.
7. Enter the single purpose (`chrome-dashboard-final.md`).
8. Enter the permission justifications (`storage`, `http://*/*`, `https://*/*`).
9. Remote code: **No**.
10. Complete the privacy practices with the prepared answers (`chrome-dashboard-final.md`, `chrome-privacy-practices.md`);
    `VERIFY_EXACT_UI_WORDING_AT_SUBMISSION`.
11. Enter the real public privacy-policy URL (check HTTP 200 and that it matches `PRIVACY_POLICY.md`).
12. Enter the support contact or URL.
13. Select the category: `VERIFY_IN_DASHBOARD` (preferred: Accessibility, if currently offered).
14. Check the dashboard's data checkbox wording against the prepared meaning (website content only).
15. Review the distribution settings.
16. Stop before the final submit action unless explicitly authorized.

## Mozilla Add-ons (AMO)

1. Sign in to AMO (a Mozilla account with developer access).
2. Create a new add-on submission (listed on AMO).
3. Verify the permanent id expectation: `coloradapt@melkumyan`; uniqueness is confirmed only by the upload.
4. Upload `firefox/coloradapt-firefox-0.1.0.zip`.
5. Upload `source/coloradapt-source-0.1.0.zip` when it asks for source code.
6. Paste the Notes for Reviewers block from `amo-reviewer-notes.md`.
7. Set the license to custom / "All Rights Reserved" as the form offers it (text in `LICENSE`).
8. Enter the privacy-policy and support URLs.
9. Verify the data-collection disclosure AMO shows: required none, optional website content.
10. Complete the listing from `firefox-listing.md` and `firefox-listing.ru.md`, with the screenshots.
11. Stop before the final submission action unless explicitly authorized.
