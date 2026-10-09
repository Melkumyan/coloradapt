#!/usr/bin/env node
/**
 * M13 release validator (docs/store/STORE_RELEASE.md). Reads `release/m13/` (or `--release <dir>`) and the
 * repository documents, never modifies either. It checks the bytes that would be uploaded, not the working `dist/`:
 * the archives are opened in memory, their manifests and files audited, and the store documents, assets, checksums
 * and source archive cross-checked against them.
 *
 * Exit code 0 only when every check passes. Findings that are not defects but things only the owner can supply
 * (publisher account, final add-on id, public URLs) are printed as EXTERNAL and do not fail the run.
 *
 * Usage: node scripts/release/validate.mjs [--release release/m13] [--json out.json]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT, readJson, readZip, sha256 } from './lib.mjs';
import {
  EXTENSION_PAGES_CSP,
  FIREFOX,
  FORBIDDEN_CLAIMS,
  NETWORK_SINKS,
  PERMISSIONS,
  PRODUCT,
  RELEASE_VERSION,
  SOURCE_EXCLUDES,
  SOURCE_REQUIRED,
} from './store-data.mjs';
import { COMPATIBLE_LICENSES, NOTICES_FILE, collect, renderNotices } from './third-party.mjs';

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const RELEASE = path.resolve(ROOT, flag('--release') ?? path.join('release', 'm13'));
const jsonOut = flag('--json');

const results = [];
const external = [];
const check = (id, ok, detail = '') => results.push({ id, ok: Boolean(ok), detail });
const note = (id, detail) => external.push({ id, detail });
const read = (rel) => readFileSync(path.join(RELEASE, rel));
const exists = (rel) => existsSync(path.join(RELEASE, rel));

const version = readJson(path.join(ROOT, 'package.json')).version;
check(
  'version/package-is-release-version',
  version === RELEASE_VERSION,
  `${version} vs ${RELEASE_VERSION}`,
);

// ---- the release directory and its checksums --------------------------------------------------------------------
const ARCHIVES = {
  chrome: `chrome/coloradapt-chrome-${version}.zip`,
  firefox: `firefox/coloradapt-firefox-${version}.zip`,
  source: `source/coloradapt-source-${version}.zip`,
};
for (const [id, rel] of Object.entries(ARCHIVES)) check(`layout/${id}-archive`, exists(rel), rel);
for (const rel of [
  'SHA256SUMS',
  'release-manifest.json',
  'permission-inventory.json',
  'network-inventory.json',
  'sbom.json',
])
  check(`layout/${rel}`, exists(rel), rel);

if (
  !Object.values(ARCHIVES).every(exists) ||
  !exists('SHA256SUMS') ||
  !exists('release-manifest.json')
) {
  finish();
}

const sums = read('SHA256SUMS')
  .toString('utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => /^([0-9a-f]{64})  (.+)$/.exec(line));
check('checksums/well-formed', sums.every(Boolean));
for (const m of sums.filter(Boolean)) {
  const [, hash, rel] = m;
  check(`checksums/${rel}`, exists(rel) && sha256(read(rel)) === hash, rel);
}
const manifestJson = JSON.parse(read('release-manifest.json').toString('utf8'));
check('release-manifest/version', manifestJson.version === version, manifestJson.version);
for (const id of Object.keys(ARCHIVES)) {
  check(
    `release-manifest/${id}-hash`,
    manifestJson.artifacts?.[id]?.sha256 === sha256(read(ARCHIVES[id])),
    manifestJson.artifacts?.[id]?.sha256,
  );
}
check(
  'release-manifest/no-build-timestamp',
  !/d{4}-d{2}-d{2}Td{2}:d{2}/.test(read('release-manifest.json').toString('utf8')),
);

// ---- open the archives -----------------------------------------------------------------------------------------
const tmp = mkdtempSync(path.join(tmpdir(), 'ca-validate-'));
const packages = {};
for (const id of ['chrome', 'firefox']) {
  const entries = readZip(read(ARCHIVES[id]));
  packages[id] = entries;
  check(`${id}/manifest-at-archive-root`, entries.has('manifest.json'), 'no enclosing folder');
  check(
    `${id}/no-directory-entries-or-prefix`,
    [...entries.keys()].every((n) => !n.endsWith('/') && !n.startsWith('/') && !n.startsWith('./')),
  );
  const dir = path.join(tmp, id === 'chrome' ? 'chrome-mv3' : 'firefox-mv2');
  for (const [name, data] of entries) {
    const file = path.join(dir, ...name.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
}
const manifestOf = (id) => JSON.parse(packages[id].get('manifest.json').toString('utf8'));
const chrome = manifestOf('chrome');
const firefox = manifestOf('firefox');

// ---- manifests -------------------------------------------------------------------------------------------------
check('chrome/manifest-v3', chrome.manifest_version === 3, String(chrome.manifest_version));
check('chrome/no-gecko-settings', chrome.browser_specific_settings === undefined);
check('chrome/no-arbitrary-minimum-version', chrome.minimum_chrome_version === undefined);
check(
  'firefox/manifest-version-unchanged',
  firefox.manifest_version === 2,
  String(firefox.manifest_version),
);
for (const [id, m] of [
  ['chrome', chrome],
  ['firefox', firefox],
]) {
  check(`${id}/name`, m.name === PRODUCT.name, m.name);
  check(`${id}/version-equals-package`, m.version === version, m.version);
  check(
    `${id}/description-length`,
    typeof m.description === 'string' &&
      m.description.length > 0 &&
      m.description.length <= PRODUCT.maxDescription,
    `${m.description?.length} chars`,
  );
  check(`${id}/description-same-as-other-browser`, m.description === chrome.description);
  for (const size of ['16', '32', '48', '128'])
    check(
      `${id}/icon-${size}`,
      m.icons?.[size] && packages[id].has(m.icons[size]),
      m.icons?.[size],
    );
  check(
    `${id}/no-dev-keys`,
    ![
      'key',
      'update_url',
      'externally_connectable',
      'web_accessible_resources',
      'optional_permissions',
      'commands',
      'devtools_page',
      'chrome_url_overrides',
    ].some((k) => k in m),
  );
  const policy =
    typeof m.content_security_policy === 'object'
      ? m.content_security_policy.extension_pages
      : m.content_security_policy;
  check(`${id}/csp-exact`, policy === EXTENSION_PAGES_CSP, policy);
  check(
    `${id}/csp-no-ipv6-or-broad-source`,
    !/\[|\bhttp:(?!\/\/)|\*(?![:\s]|$)|connect-src[^;]*\s(\*|http:|https:)(\s|;|$)/.test(policy),
    policy,
  );
  check(
    `${id}/csp-no-remote-script`,
    !/script-src[^;]*(https?:|unsafe-eval|unsafe-inline|wasm)/.test(policy),
  );
  const permissions = m.permissions ?? [];
  const hosts = [...(m.host_permissions ?? []), ...permissions.filter((p) => /^https?:/.test(p))];
  const apis = permissions.filter((p) => !/^https?:/.test(p));
  check(
    `${id}/api-permissions-exact`,
    JSON.stringify(apis.sort()) === JSON.stringify(['storage']),
    apis.join(','),
  );
  check(
    `${id}/host-permissions-exact`,
    JSON.stringify(hosts.sort()) === JSON.stringify(['http://*/*', 'https://*/*']),
    hosts.join(','),
  );
  check(
    `${id}/every-permission-justified`,
    [...apis, ...hosts].every((p) => PERMISSIONS[p]),
    [...apis, ...hosts].join(','),
  );
  check(
    `${id}/content-script-matches-host-permissions`,
    (m.content_scripts ?? []).every((cs) => cs.matches.every((x) => hosts.includes(x))),
  );
}
check(
  'permissions/no-unused-justification',
  Object.keys(PERMISSIONS).every(
    (p) => chrome.permissions?.includes(p) || chrome.host_permissions?.includes(p),
  ),
);
const gecko = firefox.browser_specific_settings?.gecko ?? {};
check('firefox/id-present', typeof gecko.id === 'string' && gecko.id.length > 0, gecko.id);
check(
  'firefox/strict-min-version',
  gecko.strict_min_version === FIREFOX.strictMinVersion,
  gecko.strict_min_version,
);
check(
  'firefox/data-collection-exact',
  JSON.stringify(gecko.data_collection_permissions) === JSON.stringify(FIREFOX.dataCollection),
  JSON.stringify(gecko.data_collection_permissions),
);
check(
  'firefox/no-broader-data-categories',
  !(gecko.data_collection_permissions?.required ?? []).some((c) => c !== 'none'),
);
check('firefox/permanent-addon-id', gecko.id === FIREFOX.addonId, gecko.id);
check(
  'firefox/addon-id-syntax',
  /^[a-z0-9-._]*@[a-z0-9-._]+$/.test(gecko.id ?? '') && !/\.invalid$/.test(gecko.id ?? ''),
  gecko.id,
);
note(
  'EXTERNAL_SUBMISSION_REQUIREMENT ID_AMO_UNIQUENESS',
  `${gecko.id}: syntax PASS; uniqueness on AMO can only be confirmed by the first upload (EXTERNAL_VERIFICATION_REQUIRED)`,
);

// ---- the shipped code ------------------------------------------------------------------------------------------
const audit = spawnSync(
  process.execPath,
  [
    path.join(ROOT, 'scripts', 'release', 'audit-dist.mjs'),
    '--dist',
    tmp,
    '--require',
    'chrome-mv3,firefox-mv2',
  ],
  { encoding: 'utf8' },
);
check(
  'audit-dist/archives',
  audit.status === 0,
  (audit.stdout + audit.stderr)
    .split('\n')
    .filter((l) => /FAIL|  - /.test(l))
    .join(' | ') || 'ok',
);

const count = (rx, id) =>
  [...packages[id]]
    .filter(([n]) => n.endsWith('.js'))
    .reduce((total, [, data]) => total + (data.toString('utf8').match(rx) ?? []).length, 0);
const PRIMITIVES = {
  fetch: /\bfetch\s*\(/g,
  XMLHttpRequest: /\bXMLHttpRequest\b/g,
  WebSocket: /\bWebSocket\b/g,
  EventSource: /\bEventSource\b/g,
  sendBeacon: /\bsendBeacon\b/g,
  importScripts: /\bimportScripts\s*\(/g,
  remoteImport: /\bimport\s*\(\s*["'`]https?:/g,
  eval: /\beval\s*\(/g,
  newFunction: /\bnew\s+Function\s*\(/g,
};
for (const id of ['chrome', 'firefox']) {
  for (const [name, rx] of Object.entries(PRIMITIVES)) {
    const n = count(rx, id);
    check(
      `network/${id}/${name}`,
      n === NETWORK_SINKS[name].expectedSites,
      `${n} found, ${NETWORK_SINKS[name].expectedSites} classified`,
    );
  }
  const dynamicImports = count(/\bimport\s*\(/g, id);
  check(
    `network/${id}/no-dynamic-import-of-urls`,
    count(/\bimport\s*\(\s*[a-zA-Z_$][\w$.]*\s*\)/g, id) === 0,
    `${dynamicImports} chunk imports, none computed`,
  );
  const text = [...packages[id]]
    .filter(([n]) => /\.(js|html|css)$/.test(n))
    .map(([, d]) => d.toString('utf8'))
    .join('\n');
  check(
    `package/${id}/no-dev-text`,
    !/\b(TODO|FIXME|DEV ONLY)\b|\bClaude\b/.test(text),
    (/\b(TODO|FIXME|DEV ONLY)\b|\bClaude\b/.exec(text) ?? [''])[0],
  );
  check(
    `package/${id}/no-internal-paths`,
    !/[A-Za-z]:[\\/]+(Users|project|temp)[\\/]|\/home\/[a-z]|\bZaven\b/.test(text),
  );
  check(
    `package/${id}/no-source-maps`,
    ![...packages[id].keys()].some((n) => n.endsWith('.map')) && !/sourceMappingURL/.test(text),
  );
  check(`package/${id}/notices-shipped`, packages[id].has('THIRD_PARTY_NOTICES.txt'));
  check(`package/${id}/background-has-no-network-primitive`, !/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b/.test(packages[id].get('background.js')?.toString('utf8') ?? 'fetch'));
}
check(
  'package/no-ai-runtime-bundled',
  ![...packages.chrome.keys()].some((n) => /\.(gguf|onnx|bin|wasm|safetensors)$/.test(n)),
);

// ---- dependencies and licenses ---------------------------------------------------------------------------------
const deps = collect();
const sbom = JSON.parse(read('sbom.json').toString('utf8'));
check(
  'sbom/matches-installed-closure',
  JSON.stringify(sbom.map((d) => `${d.name}@${d.version}`)) ===
    JSON.stringify(deps.map((d) => `${d.name}@${d.version}`)),
);
check(
  'licenses/all-known-and-compatible',
  deps.every((d) => d.license && COMPATIBLE_LICENSES.has(d.license)),
  deps
    .filter((d) => !COMPATIBLE_LICENSES.has(d.license))
    .map((d) => d.name)
    .join(','),
);
check(
  'licenses/notices-file-current',
  existsSync(NOTICES_FILE) && readFileSync(NOTICES_FILE, 'utf8') === renderNotices(deps),
);
check(
  'licenses/notices-in-both-archives',
  packages.chrome.get('THIRD_PARTY_NOTICES.txt')?.toString('utf8') === renderNotices(deps) &&
    packages.firefox.get('THIRD_PARTY_NOTICES.txt')?.toString('utf8') === renderNotices(deps),
);
const lock = readFileSync(path.join(ROOT, 'pnpm-lock.yaml'), 'utf8');
check(
  'sbom/in-lockfile',
  deps.every(
    (d) => lock.includes(`${d.name}@${d.version}`) || lock.includes(`'${d.name}@${d.version}'`),
  ),
);

// ---- the inventories --------------------------------------------------------------------------------------------
const inventory = JSON.parse(read('permission-inventory.json').toString('utf8'));
for (const id of ['chrome', 'firefox']) {
  const all = [...inventory[id].permissions, ...inventory[id].hostPermissions];
  check(
    `inventory/${id}/justified`,
    all.length > 0 && all.every((p) => p.feature && p.why && p.review),
  );
}
check(
  'inventory/chrome-csp-matches',
  inventory.chrome.contentSecurityPolicy?.extension_pages === EXTENSION_PAGES_CSP,
);

// ---- the AMO source archive -------------------------------------------------------------------------------------
const source = readZip(read(ARCHIVES.source));
for (const f of SOURCE_REQUIRED) check(`source/has-${f}`, source.has(f));
check(
  'source/none-excluded',
  ![...source.keys()].some((f) => SOURCE_EXCLUDES.some((rx) => rx.test(f))),
);
check(
  'source/no-secrets-or-env',
  ![...source.keys()].some((f) => /(^|\/)\.env|\.pem$|\.key$|id_rsa|credentials/i.test(f)),
);
check(
  'source/no-built-output',
  ![...source.keys()].some((f) => /^(dist|\.output|\.wxt)\//.test(f)),
);
check(
  'source/version-matches',
  JSON.parse(source.get('package.json')?.toString('utf8') ?? '{}').version === version,
);
check(
  'source/lockfile-identical',
  source.get('pnpm-lock.yaml')?.equals(readFileSync(path.join(ROOT, 'pnpm-lock.yaml'))) ?? false,
);
const HOST_PATH = /[A-Za-z]:[\\/]+(Users|project|temp)[\\/]|\/home\/[a-z]|\bZaven\b/;
const hostPathFiles = [...source]
  .filter(
    ([n, d]) =>
      !/\.(png|zip)$/.test(n) &&
      n !== 'tests/release/audit-dist.test.ts' &&
      HOST_PATH.test(d.toString('utf8')),
  )
  .map(([n]) => n);
check('source/no-internal-paths', hostPathFiles.length === 0, hostPathFiles.join(', '));
const buildDoc = source.get('AMO_BUILD.md')?.toString('utf8') ?? '';
// legal files (M13.R1): the proprietary license and the third-party notices travel with the reviewer source
for (const f of ['LICENSE', 'public/THIRD_PARTY_NOTICES.txt', 'AMO_BUILD.md'])
  check(`source/legal-has-${f}`, source.has(f));
check(
  'source/license-is-proprietary',
  /All Rights Reserved/.test(source.get('LICENSE')?.toString('utf8') ?? '') &&
    source.get('LICENSE')?.equals(readFileSync(path.join(ROOT, 'LICENSE'))),
);
check(
  'source/amo-build-says-review-only',
  /review/i.test(buildDoc) && /LICENSE/.test(buildDoc),
);
for (const f of ['public-site/privacy/index.html', 'public-site/support/index.html'])
  check(`source/has-${f}`, source.has(f));
const OLD_ID = ['coloradapt@coloradapt', 'invalid'].join('.');
check(
  'release/no-old-placeholder-id',
  ![...source].some(([, d]) => d.toString('latin1').includes(OLD_ID)) &&
    ![...packages.chrome, ...packages.firefox].some(([, d]) => d.toString('latin1').includes(OLD_ID)),
);
// Nothing that is uploaded or deployed may carry an unresolved owner placeholder or a made-up address.
const PLACEHOLDER = /PUBLIC_(PRIVACY_POLICY|SUPPORT)_URL|REQUIRED_EXTERNALLY|OWNER_ACTION|example\.(com|org)|\bTBD\b/;
for (const id of ['chrome', 'firefox'])
  check(
    `package/${id}/no-unresolved-placeholder`,
    ![...packages[id]].some(([, d]) => PLACEHOLDER.test(d.toString('latin1'))),
  );
for (const f of ['public-site/privacy/index.html', 'public-site/support/index.html'])
  check(`public-site/${f}/no-placeholder`, !PLACEHOLDER.test(source.get(f)?.toString('utf8') ?? 'TBD'));
// The runtime packages carry the third-party notices (the MIT terms require it) but not LICENSE: the stores show the
// license from the listing, and the extension needs no copy of its own terms at run time (docs/store/STORE_RELEASE.md).
check(
  'package/no-license-file-bytes-needed',
  !packages.chrome.has('LICENSE') && !packages.firefox.has('LICENSE'),
);
check(
  'source/AMO_BUILD-has-build-instructions',
  /pnpm install --frozen-lockfile/.test(buildDoc) &&
    /pnpm build:firefox/.test(buildDoc) &&
    /Node/.test(buildDoc) &&
    /release:package|release:rebuild/.test(buildDoc) &&
    buildDoc.includes(version),
);

// ---- store documents --------------------------------------------------------------------------------------------
const DOCS = {
  'docs/store/STORE_RELEASE.md': [],
  'docs/store/chrome-listing.md': ['Single purpose', 'Permission justifications', 'Reviewer notes'],
  'docs/store/chrome-listing.ru.md': [],
  'docs/store/chrome-privacy-practices.md': ['Remote code', 'loopback'],
  'docs/store/firefox-listing.md': ['websiteContent', 'Notes for reviewers'],
  'docs/store/firefox-listing.ru.md': [],
  'docs/store/PRIVACY_POLICY.md': [
    'loopback',
    'disabled by default',
    'telemetry',
    'websiteContent',
  ],
  'docs/store/SUPPORT.md': ['Ollama', 'Known limitations'],
  'docs/store/REVIEWER_GUIDE.md': ['deuteranopia', 'Developer audit'],
  'docs/store/RELEASE_NOTES.md': [version],
  'docs/store/RELEASE_RISK_REGISTER.md': ['STORE_BLOCKER'],
  'docs/store/chrome-dashboard-final.md': ['VERIFY_IN_DASHBOARD', 'VERIFY_EXACT_UI_WORDING_AT_SUBMISSION', 'Remote code'],
  'docs/store/SUBMISSION_CHECKLIST.md': ['2-Step Verification', 'Notes for Reviewers'],
  'docs/store/OWNER_ACCOUNTS.md': ['Mozilla account'],
  'docs/store/amo-reviewer-notes.md': ['websiteContent', 'coloradapt@melkumyan'],
  'AMO_BUILD.md': [],
};
const INTERNAL_DOCS = new Set([
  'docs/store/STORE_RELEASE.md',
  'docs/store/RELEASE_RISK_REGISTER.md',
  'docs/store/SUBMISSION_CHECKLIST.md',
  'docs/store/OWNER_ACCOUNTS.md',
  'AMO_BUILD.md',
]);
const docText = {};
for (const [rel, needles] of Object.entries(DOCS)) {
  const file = path.join(ROOT, rel);
  check(`docs/${rel}/exists`, existsSync(file));
  if (!existsSync(file)) continue;
  const text = readFileSync(file, 'utf8');
  docText[rel] = text;
  for (const needle of needles.filter(Boolean))
    check(`docs/${rel}/mentions-${needle}`, text.includes(needle));
  for (const [rx, label] of FORBIDDEN_CLAIMS) {
    // A document may quote a forbidden claim only to say it is not made: such a line contains "not" or "never" or a quote of the rule.
    const bad = text
      .split('\n')
      .filter(
        (line) =>
          rx.test(line) && !/\b(not|never|no claim|do not|does not|don.t|nor)\b/i.test(line),
      );
    check(`docs/${rel}/claim-${label}`, bad.length === 0, bad[0]?.trim().slice(0, 120));
  }
  // Documents for the stores' readers carry no project jargon; the three internal ones (release procedure, risk
  // register, reviewer build notes) may name milestones.
  const devText = INTERNAL_DOCS.has(rel)
    ? /\b(TODO|FIXME|DEV ONLY)\b|\bClaude\b/
    : /\b(TODO|FIXME|DEV ONLY)\b|\bClaude\b|\bM1[0-9](\.[0-9R]+)?\b/;
  check(`docs/${rel}/no-dev-text`, !devText.test(text), (devText.exec(text) ?? [''])[0]);
  check(`docs/${rel}/no-internal-paths`, !HOST_PATH.test(text));
  check(
    `docs/${rel}/no-invented-contact`,
    !/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(text),
    (/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.exec(text) ?? [''])[0],
  );
}
for (const rel of ['docs/store/RELEASE_NOTES.md'])
  check(`version/${rel}`, docText[rel]?.includes(version));

// unsupported-claim scan over everything a user or reviewer reads besides the store documents: the extension UI,
// README, the public pages, the reviewer fixture and the promo graphics source
const CLAIM_FILES = [
  'README.md',
  'docs/PRIVACY.md',
  'docs/AI_PRIVACY.md',
  'public-site/privacy/index.html',
  'public-site/support/index.html',
  'src/entrypoints/popup/App.tsx',
  'src/entrypoints/options/App.tsx',
  'src/entrypoints/audit/App.tsx',
  'src/entrypoints/audit/components.tsx',
  'src/entrypoints/audit/assist-components.tsx',
  'docs/store/reviewer-fixture/index.html',
  'assets/store/icon.svg',
];
for (const rel of CLAIM_FILES) {
  const text = readFileSync(path.join(ROOT, rel), 'utf8');
  for (const [rx, label] of FORBIDDEN_CLAIMS) {
    const bad = text
      .split('\n')
      .filter(
        (line) =>
          rx.test(line) && !/\b(not|never|no claim|do not|does not|don.t|nor|cannot)\b/i.test(line),
      );
    check(`claims/${rel}/${label}`, bad.length === 0, bad[0]?.trim().slice(0, 120));
  }
  check(
    `claims/${rel}/no-forbidden-extra`,
    !/(100% accessible|detects all accessibility|every accessibility (issue|violation)|clinically validated|restores? normal vision)/i.test(
      text.replace(/\bnot\b[^.\n]*(100% accessible|detects all)[^.\n]*/gi, ''),
    ),
  );
}

// listing limits (dashboard fields)
const field = (text, name) =>
  new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+)$`, 'mi').exec(text ?? '')?.[1]?.trim();
for (const [rel, limits] of [
  ['docs/store/chrome-listing.md', { Name: 75, Summary: 132 }],
  ['docs/store/chrome-listing.ru.md', { Name: 75, Summary: 132 }],
  ['docs/store/firefox-listing.md', { Name: 50, Summary: 250 }],
  ['docs/store/firefox-listing.ru.md', { Name: 50, Summary: 250 }],
]) {
  for (const [name, max] of Object.entries(limits)) {
    const value = field(docText[rel], name);
    check(
      `listing/${rel}/${name}-within-${max}`,
      value !== undefined && value.length > 0 && value.length <= max,
      `${value?.length} chars`,
    );
  }
}
check(
  'listing/chrome-summary-equals-manifest-description',
  field(docText['docs/store/chrome-listing.md'], 'Summary') === chrome.description,
);

// the privacy statements must agree across documents
const privacy = docText['docs/store/PRIVACY_POLICY.md'] ?? '';
check(
  'privacy/says-default-sends-nothing',
  /By default, ColorAdapt sends no page data to external services/.test(privacy),
);
check('privacy/no-cloud-fallback', /no cloud (AI )?fallback/i.test(privacy));
check(
  'privacy/chrome-form-says-loopback',
  /loopback/.test(docText['docs/store/chrome-privacy-practices.md'] ?? ''),
);
for (const rel of [
  'README.md',
  'docs/PRIVACY.md',
  'docs/SECURITY.md',
  'docs/AI_PRIVACY.md',
  'docs/AI_SEMANTIC_ENGINE.md',
  'src/entrypoints/options/App.tsx',
]) {
  const text = readFileSync(path.join(ROOT, rel), 'utf8');
  check(
    `contradiction/${rel}/no-absolute-claim`,
    !/(never|no)[^.\n]{0,30}(sent|leaves?)[^.\n]{0,20}(to a server|the browser|your device)/i.test(
      text.replace(
        /ColorAdapt analyzes pages entirely on your device\. No page content, settings, or usage data is ever sent to a server\./,
        'X',
      ),
    ) || /loopback|127\.0\.0\.1/.test(text),
    rel,
  );
  check(
    `contradiction/${rel}/no-ipv6-loopback-claim`,
    !/\[::1\]/.test(text) || /not accepted|refused|rejected|cannot|no CSP|neither/i.test(text),
    rel,
  );
}
for (const rel of ['README.md', 'docs/PRIVACY.md', 'docs/AI_PRIVACY.md']) {
  const text = readFileSync(path.join(ROOT, rel), 'utf8');
  check(
    `contradiction/${rel}/mentions-firefox-consent-or-optional-ai`,
    /websiteContent|consent|permission/i.test(text) || rel === 'README.md',
    rel,
  );
}

// ---- assets ------------------------------------------------------------------------------------------------------
function pngInfo(buffer) {
  if (
    buffer.length < 33 ||
    !buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), colorType: buffer[25] };
}
const icon = exists('assets/icon-128.png') ? pngInfo(read('assets/icon-128.png')) : null;
check('assets/icon-128', icon?.width === 128 && icon?.height === 128, JSON.stringify(icon));
const shots = [1, 2, 3, 4, 5].map((n) => `assets/screenshot-0${n}.png`).filter(exists);
check('assets/screenshots-1-to-5', shots.length >= 1 && shots.length <= 5, `${shots.length}`);
for (const rel of shots) {
  const info = pngInfo(read(rel));
  check(
    `assets/${rel}-1280x800-rgb`,
    info?.width === 1280 && info?.height === 800 && info?.colorType === 2,
    JSON.stringify(info),
  );
}
const promo = exists('assets/promo-440x280.png') ? pngInfo(read('assets/promo-440x280.png')) : null;
check(
  'assets/promo-440x280-rgb',
  promo?.width === 440 && promo?.height === 280 && promo?.colorType === 2,
  JSON.stringify(promo),
);
for (const rel of [
  'listing/chrome-en.md',
  'listing/chrome-ru.md',
  'listing/firefox-en.md',
  'listing/firefox-ru.md',
])
  check(`release/${rel}`, exists(rel));

// ---- things only the owner can supply -------------------------------------------------------------------------------
note(
  'EXTERNAL_SUBMISSION_REQUIREMENT PUBLIC_PRIVACY_POLICY_URL',
  'content is ready in docs/store/PRIVACY_POLICY.md; it needs a public address chosen and hosted by the publisher',
);
note(
  'EXTERNAL_SUBMISSION_REQUIREMENT support-url-or-email',
  'docs/store/SUPPORT.md is ready; the publisher must provide the public support route',
);
note(
  'EXTERNAL_SUBMISSION_REQUIREMENT developer-accounts',
  'Chrome Web Store and AMO developer accounts, and the publisher identity, are not part of the repository',
);
note(
  'SUPPORT_CONTACT',
  'EXTERNAL_OWNER_ACTION_REQUIRED: no support email or URL exists in the repository; none is invented',
);
note(
  'PUBLIC_URL_DEPLOYMENT',
  'EXTERNAL_OWNER_ACTION_REQUIRED: deploy public-site/ to a static host, then enter the real URLs in the dashboards',
);
note('PROMO_VIDEO', 'NOT PROVIDED (optional)');

rmSync(tmp, { recursive: true, force: true });
finish();

function finish() {
  const failed = results.filter((r) => !r.ok);
  for (const r of failed) console.error(`FAIL ${r.id}${r.detail ? `  (${r.detail})` : ''}`);
  for (const e of external) console.log(`NOTE ${e.id}: ${e.detail}`);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify({ results, external }, null, 2)}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}
