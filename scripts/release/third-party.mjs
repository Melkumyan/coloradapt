#!/usr/bin/env node
/**
 * Production dependency inventory (SBOM) and the third-party notices that ship inside the package.
 *
 * The closure is read from node_modules (the frozen lockfile's install): `dependencies` of package.json, then their
 * own `dependencies`, each with name, version, license, source and the license text found in the package.
 *
 *   node scripts/release/third-party.mjs --write     rewrite public/THIRD_PARTY_NOTICES.txt
 *   node scripts/release/third-party.mjs --check     exit 1 if that file is out of date
 *   node scripts/release/third-party.mjs --sbom f    write the inventory as JSON
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, readJson } from './lib.mjs';

/** SPDX identifiers whose terms allow redistribution inside this extension with the notice kept. */
export const COMPATIBLE_LICENSES = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
]);
export const NOTICES_FILE = path.join(ROOT, 'public', 'THIRD_PARTY_NOTICES.txt');

function locate(fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return path.dirname(realpathSync(candidate));
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`cannot resolve ${name} from ${fromDir}`);
    dir = parent;
  }
}

function licenseText(dir) {
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'License']) {
    const file = path.join(dir, name);
    if (existsSync(file)) return readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
  }
  return null;
}

function repositoryOf(manifest) {
  const repo = manifest.repository;
  const url = typeof repo === 'string' ? repo : (repo?.url ?? manifest.homepage ?? null);
  return url ? url.replace(/^git\+/, '').replace(/^git@github\.com:/, 'https://github.com/') : null;
}

export function collect() {
  const root = readJson(path.join(ROOT, 'package.json'));
  const seen = new Map();
  const visit = (name, fromDir) => {
    const dir = locate(fromDir, name);
    const manifest = readJson(path.join(dir, 'package.json'));
    const key = `${manifest.name}@${manifest.version}`;
    if (seen.has(key)) return;
    seen.set(key, {
      name: manifest.name,
      version: manifest.version,
      license: typeof manifest.license === 'string' ? manifest.license : null,
      source: repositoryOf(manifest),
      npm: `https://www.npmjs.com/package/${manifest.name}/v/${manifest.version}`,
      licenseText: licenseText(dir),
    });
    for (const dep of Object.keys(manifest.dependencies ?? {})) visit(dep, dir);
  };
  for (const dep of Object.keys(root.dependencies ?? {})) visit(dep, ROOT);
  return [...seen.values()].sort((a, b) => (a.name + a.version < b.name + b.version ? -1 : 1));
}

export function renderNotices(packages) {
  const parts = [
    'ColorAdapt bundles the following third-party software. Each is distributed under the license shown,',
    'whose text follows. This file lists the production dependencies only; nothing else is shipped.',
    '',
  ];
  for (const p of packages) {
    parts.push(
      '='.repeat(72),
      `${p.name} ${p.version}`,
      `License: ${p.license ?? 'UNKNOWN'}`,
      `Source:  ${p.source ?? p.npm}`,
      '='.repeat(72),
      p.licenseText ?? '(no license file in the package; license field only)',
      '',
    );
  }
  return `${parts.join('\n')}\n`;
}

export function inventory() {
  return collect().map(({ licenseText: _text, ...rest }) => rest);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const text = renderNotices(collect());
  if (argv.includes('--write')) {
    writeFileSync(NOTICES_FILE, text);
    console.log(`wrote ${path.relative(ROOT, NOTICES_FILE)}`);
  }
  if (argv.includes('--check')) {
    const current = existsSync(NOTICES_FILE) ? readFileSync(NOTICES_FILE, 'utf8') : '';
    if (current !== text) {
      console.error(
        'public/THIRD_PARTY_NOTICES.txt is out of date: run node scripts/release/third-party.mjs --write',
      );
      process.exit(1);
    }
    console.log('ok   third-party notices up to date');
  }
  if (argv.includes('--sbom')) {
    writeFileSync(argv[argv.indexOf('--sbom') + 1], `${JSON.stringify(inventory(), null, 2)}\n`);
  }
}
