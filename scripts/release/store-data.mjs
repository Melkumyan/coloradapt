/**
 * The facts the store release is built and checked against (M13, docs/store/STORE_RELEASE.md). One place, so the
 * package script, the validator, the permission inventory and the unit tests cannot drift apart.
 */

export const PRODUCT = {
  name: 'ColorAdapt',
  /** The one purpose both stores see (Chrome "single purpose", AMO summary). */
  singlePurpose:
    'ColorAdapt improves the readability and distinguishability of web interfaces for people with color-vision deficiencies by adapting color-dependent visual information in the browser.',
  /** Chrome limits the manifest description to 132 characters. */
  maxDescription: 132,
};

/** The first public release version, a deliberate decision (docs/store/STORE_RELEASE.md, "Release version"). */
export const RELEASE_VERSION = '0.1.0';

export const POLICY_SNAPSHOT = {
  date: '2026-10-09',
  sources: {
    chromePolicies: 'https://developer.chrome.com/docs/webstore/program-policies/policies',
    firefoxDataConsent:
      'https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/',
    amoSource: 'https://extensionworkshop.com/documentation/publish/source-code-submission/',
    mdnCsp:
      'https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_security_policy',
  },
};

/** The exact extension-page policy of both packages (no IPv6 loopback: neither browser can express it). */
export const EXTENSION_PAGES_CSP =
  "script-src 'self'; object-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:*";

export const FIREFOX = {
  /** Permanent once published (owner decision, M13.R1). */
  addonId: 'coloradapt@melkumyan',
  strictMinVersion: '140.0',
  dataCollection: { required: ['none'], optional: ['websiteContent'] },
};

/**
 * Why every permission exists, per browser package. `optionalPossible` answers "could this be an optional
 * permission?". A permission in a manifest with no entry here fails the validator; an entry whose permission
 * is no longer in a manifest is reported too.
 */
export const PERMISSIONS = {
  storage: {
    kind: 'api',
    feature: 'Settings: profile, strength, per-feature switches, AI settings',
    why: 'Keeps the user’s own settings in the browser (storage.local) so they survive restarts. Nothing else is stored.',
    optionalPossible: false,
    review:
      'Used only to save and read the extension’s own settings (src/infrastructure/storage). No page content is stored.',
  },
  'http://*/*': {
    kind: 'host',
    feature: 'Page adaptation (content script) on http pages',
    why: 'The core function reads colors and structure of the page the user is on and adds a stylesheet to it; that needs a content script on any website where the user turns ColorAdapt on.',
    optionalPossible:
      'Not without breaking the purpose: the person cannot know in advance which sites they will need to read. The user can turn Protection off at any time and the page is given back.',
    review:
      'ColorAdapt must inspect and adapt page presentation on websites where the user enables or uses the extension. Page data is processed locally in the browser and is not transmitted.',
  },
  'https://*/*': {
    kind: 'host',
    feature: 'Page adaptation (content script) on https pages',
    why: 'Same as http: the content script runs on every https page so that adaptation works wherever the user browses.',
    optionalPossible: 'Same as http.',
    review: 'Same as http: local analysis and adaptation of the page the user is viewing.',
  },
};

/**
 * Every network-capable call in the shipped code, classified. The validator counts occurrences of each primitive
 * in the packages and fails on anything not listed (a new sink must be reviewed and listed here).
 */
export const NETWORK_SINKS = {
  fetch: {
    expectedSites: 3,
    classification: [
      {
        where: 'audit page chunk (src/core/semantic-ai/local-provider.ts)',
        destination: 'the loopback model runtime (127.0.0.1 or localhost) the user configured',
        when: 'only when AI-assisted review is enabled and the user runs it; on Firefox only with websiteContent consent',
        data: 'a bounded, redacted semantic packet per finding that needs manual review',
        enforcedBy:
          'endpoint parser, extension-page CSP connect-src, redirect:error, credentials omit, same-origin response check',
      },
      {
        where: 'content script and shared settings chunk (src/features/images/raster-reader.ts)',
        destination:
          'the image URL the page itself already loads (same origin, data:, blob:, or a CORS-enabled image)',
        when: 'only for the opt-in image adaptation (off by default)',
        data: 'none sent: it reads the bytes of an image the page shows, locally, to recolor a monochrome icon',
        enforcedBy:
          'same-origin/CORS rule in code; the request carries what the page’s own request would',
      },
    ],
  },
  XMLHttpRequest: { expectedSites: 0 },
  WebSocket: { expectedSites: 0 },
  EventSource: { expectedSites: 0 },
  sendBeacon: { expectedSites: 0 },
  importScripts: { expectedSites: 0 },
  remoteImport: { expectedSites: 0 },
  eval: { expectedSites: 0 },
  newFunction: { expectedSites: 0 },
};

/** The source package for AMO reviewers: what is left out of the tracked tree, and why. */
export const SOURCE_EXCLUDES = [
  // Internal milestone reports and evidence (they quote the author’s machine paths; not needed to build).
  /^docs\/m12\/(protocol|report|security-review|storage)\.md$/,
  /^docs\/m125\//,
  /^docs\/validation\//,
  /^benchmark-report\//,
  /^test-results\//,
  /^release\//,
  /^dist(-profile)?\//,
  /^node_modules\//,
  /^\.git\//,
  /^\.wxt\//,
  /^\.output\//,
  /^realworld\/\.(tools|artifacts)\//,
];

/** What the source package must contain for a reviewer to rebuild the Firefox add-on. */
export const SOURCE_REQUIRED = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'wxt.config.ts',
  'AMO_BUILD.md',
  'README.md',
  'LICENSE',
  'public/THIRD_PARTY_NOTICES.txt',
  'src/entrypoints/background.ts',
  'src/entrypoints/content.ts',
  'public/icon-128.png',
  'scripts/release/audit-dist.mjs',
  'scripts/release/lib.mjs',
  'scripts/release/package.mjs',
];

/** Strings that must never appear in the store-facing documents (claims the product cannot back). */
export const FORBIDDEN_CLAIMS = [
  [
    /no data (ever )?leaves (the|your) (browser|device|computer)/i,
    'absolute "no data leaves" claim',
  ],
  [/never (leaves|leave) (the|your) (browser|device)/i, 'absolute "never leaves" claim'],
  [/clinically (validated|proven|tested)/i, 'clinical claim'],
  [/medical[- ]grade/i, 'medical claim'],
  [/restores? (normal )?(color|colour) vision/i, 'restores color vision'],
  [/(guarantee|ensures?)[^.\n]{0,40}WCAG/i, 'WCAG guarantee'],
  [/(100%|fully)\s+WCAG/i, 'WCAG compliance claim'],
  [/works? (perfectly )?on every (site|website)/i, 'works on every site'],
  [/scientifically (perfect|accurate|proven)/i, 'scientific certainty claim'],
  [/editor'?s choice|#1\b/i, 'ranking badge'],
];
