# Owner account checklist (not verified by this repository)

Nothing below is claimed as done. Each line is for the owner to confirm with real account evidence; no state is assumed.

## Chrome Web Store developer account

- [ ] A Chrome Web Store developer account exists for the publisher.
- [ ] Contact information on the account is valid and the contact email is verified.
- [ ] 2-Step Verification is enabled on the Google account that owns the developer account.
- [ ] Developer registration (and the one-time registration fee, if the dashboard asks for it) is completed.
- [ ] Publisher identity (display name, trader or non-trader status, if asked) is correct and is the intended public identity.
- [ ] Support contact (email or URL) is chosen by the owner: `SUPPORT_CONTACT: EXTERNAL_OWNER_ACTION_REQUIRED`.

## Mozilla Add-ons (AMO) developer account

- [ ] A Mozilla account exists (with two-step authentication if the owner wants it).
- [ ] AMO developer access works (the account can open the Developer Hub and start "Submit a New Add-on").
- [ ] Publisher or display identity (the author name shown on the listing) is correct.
- [ ] The Firefox Add-on Distribution Agreement is read and accepted by the owner in the Developer Hub.
- [ ] The add-on id `coloradapt@melkumyan` is accepted: its syntax is valid; uniqueness is known only at the first upload
      (`ID_AMO_UNIQUENESS: EXTERNAL_VERIFICATION_REQUIRED`). The id is permanent once published.
- [ ] Support email or website for the listing is chosen by the owner.

## Public pages

- [ ] `public-site/` is deployed to a static host the owner controls; `/privacy/` and `/support/` answer HTTP 200 over HTTPS
      and match the frozen text (`PUBLIC_URL_DEPLOYMENT: EXTERNAL_OWNER_ACTION_REQUIRED`).
