#!/usr/bin/env node
/**
 * M13 store release packaging (docs/store/STORE_RELEASE.md).
 *
 * From the working tree it builds the two extension bundles fresh (`wxt build`, production), then writes into
 * `release/m13/` (or `--out`): the Chrome and Firefox upload archives, the AMO reviewer source archive, the machine
 * readable permission / network / dependency inventories, `SHA256SUMS` and `release-manifest.json`.
 *
 * Archives are written by `lib.mjs`, not by a tool: entries are sorted, timestamps fixed, so the same bundle always
 * gives the same bytes. The script reads the sources and writes only under the output directory (and `dist/`, as
 * every build does). Validation is a separate step: `pnpm release:validate`.
 *
 * `--no-source` skips the source archive and everything that needs git: it is what a reviewer rebuild uses (the
 * extracted source archive is not a repository), and it still produces the two upload archives.
 *
 * Usage: node scripts/release/package.mjs [--out release/m13] [--no-build] [--no-source]
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, folderFiles, readJson, sha256, walk, writeZip } from './lib.mjs';
import {
  EXTENSION_PAGES_CSP,
  FIREFOX,
  NETWORK_SINKS,
  PERMISSIONS,
  POLICY_SNAPSHOT,
  PRODUCT,
  RELEASE_VERSION,
  SOURCE_EXCLUDES,
} from './store-data.mjs';
import { inventory } from './third-party.mjs';

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const OUT = path.resolve(ROOT, flag('--out') ?? path.join('release', 'm13'));
const version = readJson(path.join(ROOT, 'package.json')).version;
if (version !== RELEASE_VERSION)
  throw new Error(`package.json version ${version} is not the release version ${RELEASE_VERSION}`);

function wxt(args) {
  const run = spawnSync(
    process.execPath,
    [path.join(ROOT, 'node_modules', 'wxt', 'bin', 'wxt.mjs'), ...args],
    {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (run.status !== 0)
    throw new Error(`wxt ${args.join(' ')} failed:\n${run.stdout}\n${run.stderr}`);
}

function git(args) {
  const run = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
  return run.stdout;
}

const TARGETS = [
  {
    id: 'chrome',
    outDir: 'chrome-mv3',
    build: ['build'],
    archive: `coloradapt-chrome-${version}.zip`,
  },
  {
    id: 'firefox',
    outDir: 'firefox-mv2',
    build: ['build', '-b', 'firefox'],
    archive: `coloradapt-firefox-${version}.zip`,
  },
];

if (!argv.includes('--no-build')) {
  for (const target of TARGETS) {
    rmSync(path.join(ROOT, 'dist', target.outDir), { recursive: true, force: true });
    wxt(target.build);
  }
}

rmSync(path.join(OUT, 'chrome'), { recursive: true, force: true });
rmSync(path.join(OUT, 'firefox'), { recursive: true, force: true });
rmSync(path.join(OUT, 'source'), { recursive: true, force: true });
const artifacts = {};

// -- upload archives ---------------------------------------------------------------------------------------------
const manifests = {};
for (const target of TARGETS) {
  const dir = path.join(ROOT, 'dist', target.outDir);
  if (!existsSync(path.join(dir, 'manifest.json')))
    throw new Error(`${target.outDir} is not built`);
  const files = folderFiles(dir);
  // manifest.json first, as a convention, then the rest in byte order
  files.sort(([a], [b]) =>
    a === 'manifest.json' ? -1 : b === 'manifest.json' ? 1 : a < b ? -1 : 1,
  );
  const zip = writeZip(files);
  const file = path.join(OUT, target.id, target.archive);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, zip);
  manifests[target.id] = readJson(path.join(dir, 'manifest.json'));
  artifacts[target.id] = {
    file: `${target.id}/${target.archive}`,
    bytes: zip.length,
    sha256: sha256(zip),
    entries: files.length,
    unpackedBytes: files.reduce((n, [, data]) => n + data.length, 0),
  };
}

// -- reviewer source archive -------------------------------------------------------------------------------------
const withSource = !argv.includes('--no-source');
const listed = !withSource
  ? []
  : git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
      .split('\0')
      .filter(Boolean)
      .map((f) => f.replace(/\\/g, '/'))
      .filter((f) => existsSync(path.join(ROOT, f)) && !SOURCE_EXCLUDES.some((rx) => rx.test(f)));
const sourceFiles = [...new Set(listed)]
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  .map((f) => [f, readFileSync(path.join(ROOT, f))]);
if (withSource) {
  const sourceZip = writeZip(sourceFiles);
  const sourceName = `coloradapt-source-${version}.zip`;
  mkdirSync(path.join(OUT, 'source'), { recursive: true });
  writeFileSync(path.join(OUT, 'source', sourceName), sourceZip);
  artifacts.source = {
    file: `source/${sourceName}`,
    bytes: sourceZip.length,
    sha256: sha256(sourceZip),
    entries: sourceFiles.length,
    unpackedBytes: sourceFiles.reduce((n, [, data]) => n + data.length, 0),
  };
}

// -- inventories -------------------------------------------------------------------------------------------------
function permissionInventory(id) {
  const m = manifests[id];
  const hosts = [
    ...(m.host_permissions ?? []),
    ...(m.permissions ?? []).filter((p) => /^https?:|^<all_urls>|^\*:/.test(p)),
  ];
  const apis = (m.permissions ?? []).filter((p) => !hosts.includes(p));
  const describe = (permission) => {
    const known = PERMISSIONS[permission];
    return {
      permission,
      browser: id,
      ...(known ?? { feature: null, why: null, optionalPossible: null, review: null }),
    };
  };
  return {
    manifestVersion: m.manifest_version,
    permissions: apis.map(describe),
    hostPermissions: hosts.map(describe),
    optionalPermissions: m.optional_permissions ?? [],
    webAccessibleResources: m.web_accessible_resources ?? null,
    contentSecurityPolicy: m.content_security_policy ?? null,
    externallyConnectable: m.externally_connectable ?? null,
    background: m.background ?? null,
    contentScripts: m.content_scripts ?? [],
    dataCollection: m.browser_specific_settings?.gecko?.data_collection_permissions ?? null,
    minimumBrowserVersion:
      m.browser_specific_settings?.gecko?.strict_min_version ?? m.minimum_chrome_version ?? null,
  };
}
const writeJson = (rel, value) => {
  mkdirSync(path.dirname(path.join(OUT, rel)), { recursive: true });
  writeFileSync(path.join(OUT, rel), `${JSON.stringify(value, null, 2)}\n`);
};
writeJson('permission-inventory.json', {
  chrome: permissionInventory('chrome'),
  firefox: permissionInventory('firefox'),
});
writeJson('network-inventory.json', NETWORK_SINKS);
writeJson('sbom.json', inventory());

// -- listing and assets that are authored in the repository --------------------------------------------------------
for (const [from, to] of [
  ['docs/store/chrome-listing.md', 'listing/chrome-en.md'],
  ['docs/store/chrome-listing.ru.md', 'listing/chrome-ru.md'],
  ['docs/store/firefox-listing.md', 'listing/firefox-en.md'],
  ['docs/store/firefox-listing.ru.md', 'listing/firefox-ru.md'],
  ['assets/store/store-icon-128.png', 'assets/icon-128.png'],
]) {
  if (!existsSync(path.join(ROOT, from))) continue;
  mkdirSync(path.dirname(path.join(OUT, to)), { recursive: true });
  copyFileSync(path.join(ROOT, from), path.join(OUT, to));
}

// -- checksums and the release manifest ----------------------------------------------------------------------------
const head = withSource ? git(['rev-parse', 'HEAD']).trim() : null;
const dirty = withSource ? git(['status', '--porcelain']).trim() !== '' : null;
const sums = walk(OUT)
  .map((f) => path.relative(OUT, f).split(path.sep).join('/'))
  .filter((f) => f !== 'SHA256SUMS' && f !== 'release-manifest.json')
  .sort()
  .map((f) => `${sha256(readFileSync(path.join(OUT, f)))}  ${f}`);
writeFileSync(path.join(OUT, 'SHA256SUMS'), `${sums.join('\n')}\n`);

writeJson('release-manifest.json', {
  product: PRODUCT.name,
  version,
  singlePurpose: PRODUCT.singlePurpose,
  source: {
    baseHead: head,
    workingTreeDirty: dirty,
    note: 'The release is built from the working tree on top of baseHead; the source archive hash identifies exactly what was built.',
    sourceArchiveSha256: artifacts.source?.sha256 ?? null,
  },
  buildTimestampPolicy:
    'none: archive entries carry the ZIP epoch (1980-01-01); no build date is embedded anywhere',
  node: process.version,
  artifacts,
  manifests: {
    chrome: {
      manifest_version: manifests.chrome.manifest_version,
      version: manifests.chrome.version,
    },
    firefox: {
      manifest_version: manifests.firefox.manifest_version,
      version: manifests.firefox.version,
      id: manifests.firefox.browser_specific_settings?.gecko?.id,
      strict_min_version: FIREFOX.strictMinVersion,
      data_collection_permissions: FIREFOX.dataCollection,
    },
  },
  extensionPagesCsp: EXTENSION_PAGES_CSP,
  policySnapshot: POLICY_SNAPSHOT,
});

for (const [id, a] of Object.entries(artifacts))
  console.log(
    `${id.padEnd(8)} ${a.file}  ${a.bytes} bytes  ${a.entries} entries  sha256 ${a.sha256}`,
  );
console.log(`release written to ${path.relative(ROOT, OUT)}`);
