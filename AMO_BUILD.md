# Building the Firefox add-on from source (for AMO reviewers)

This archive is the complete source of **ColorAdapt 0.1.0**. The add-on you reviewed
(`coloradapt-firefox-0.1.0.zip`) is the output of the steps below; a rebuild is **byte-identical** to it.

## License and purpose of this archive

ColorAdapt is proprietary software (**All Rights Reserved**, see `LICENSE` in this archive). The source is supplied to
Mozilla add-on reviewers for review and reproducibility only; this does not make ColorAdapt open source and grants no
right to reuse, modify or redistribute it. The bundled third-party libraries keep their own MIT licenses
(`public/THIRD_PARTY_NOTICES.txt`). The Firefox add-on id is `coloradapt@melkumyan`.

## Environment

| What            | Value                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OS              | Verified on Windows 11 x64 (and reproduced there from this archive, byte for byte). The build has no OS-specific step, but other systems were not tested |
| Node.js         | 22.17.1 (the version used; the AMO default of Node 24 was not tested, so please use 22.17.1)                                                             |
| Package manager | pnpm 11.9.0 (`corepack enable && corepack prepare pnpm@11.9.0 --activate`, or `npm install -g pnpm@11.9.0`)                                              |
| Network         | Only to download the locked dependencies from the public npm registry. Nothing else is fetched during the build                                          |
| Build tools     | All open source and run locally: TypeScript, Vite (through WXT 0.21), React plugin. No commercial or web-based tool, no minifier service, no obfuscation |
| Disk / RAM      | < 1 GB / < 2 GB                                                                                                                                          |

## Steps

Run from the root of the extracted source archive:

```bash
pnpm install --frozen-lockfile        # exact versions from pnpm-lock.yaml; the lockfile is never regenerated
pnpm build:firefox                    # writes the unpacked add-on to dist/firefox-mv2/
node scripts/release/package.mjs --no-source --out ../out   # writes deterministic upload archives
```

`pnpm release:rebuild` runs the same steps on the release archive and compares the result.

## Output

- `dist/firefox-mv2/`: the unpacked add-on (`manifest.json`, `background.js`, `popup.html`, `options.html`,
  `audit.html`, `content-scripts/content.js`, `chunks/`, `assets/`, icons, `THIRD_PARTY_NOTICES.txt`).
- `../out/firefox/coloradapt-firefox-0.1.0.zip`: the file uploaded to AMO. Its SHA-256 is in `SHA256SUMS`
  next to the submission; it is identical to the one you were given. The archive is written by
  `scripts/release/lib.mjs` (sorted entries, fixed timestamps), so no build date or machine path is embedded.
- `../out/chrome/coloradapt-chrome-0.1.0.zip`: the Chrome Web Store archive, built the same way (not for AMO).

## Verification

```bash
pnpm audit:dist                       # checks the built bundles: permissions, CSP, forbidden files, no eval or remote code
pnpm test                             # unit tests (optional; ~3,500 tests)
```

Compare the built archive with the submitted one: `sha256sum ../out/firefox/coloradapt-firefox-0.1.0.zip`.

## What the source is

- TypeScript and React, bundled and minified by Vite through [WXT](https://wxt.dev) (`wxt.config.ts`). Entry points
  are in `src/entrypoints/`; there is no hand-written minified code and no obfuscation.
- Production dependencies (all MIT; see `public/THIRD_PARTY_NOTICES.txt` and `package.json`):
  `react` 19.3.0, `react-dom` 19.3.0 (with its `scheduler` 0.28.0) and `culori` 4.0.2. They are installed from npm and
  bundled unmodified by the build; none is copied into the repository.
- The optional AI-assisted review is a client for a model runtime **on the user's own computer** (`127.0.0.1`
  or `localhost`). No model, weights, WebAssembly or inference library is part of the add-on, and model output is
  parsed as data and validated; it is never executed. See `docs/AI_PRIVACY.md`.
- Firefox build specifics: Manifest V2 (`browser_action`, background scripts), `strict_min_version` 140.0, and
  `data_collection_permissions` with `required: ["none"]` and `optional: ["websiteContent"]` (see
  `docs/store/firefox-listing.md`, "Notes for reviewers").

## Notes

- `public/icon-*.png` are committed renderings of `assets/store/icon.svg` (`scripts/release/render-icons.mjs`
  needs Playwright and is **not** part of the build).
- `public/THIRD_PARTY_NOTICES.txt` is generated from the installed dependencies by
  `node scripts/release/third-party.mjs --write`; the build only copies it.
