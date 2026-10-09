#!/usr/bin/env node
/**
 * The AMO reviewer rebuild (AMO_BUILD.md), done the way a reviewer does it: take the source archive, extract it
 * into an empty folder, install from the frozen lockfile, build, package, and compare the resulting upload archives,
 * byte for byte, with the ones in the release folder.
 *
 * Usage: node scripts/release/rebuild-from-source.mjs [--release release/m13] [--work <empty dir>] [--offline]
 *
 * `--offline` passes `--offline` to pnpm (use the local store; no network), which is what makes the check repeatable
 * on a machine whose store already has the locked versions.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT, readJson, readZip, sha256 } from './lib.mjs';

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const RELEASE = path.resolve(ROOT, flag('--release') ?? path.join('release', 'm13'));
const version = readJson(path.join(ROOT, 'package.json')).version;
const work = flag('--work')
  ? path.resolve(flag('--work'))
  : mkdtempSync(path.join(tmpdir(), 'ca-rebuild-'));
if (existsSync(work) && readdirSync(work).length > 0) throw new Error(`${work} is not empty`);
mkdirSync(work, { recursive: true });

const sourceZip = path.join(RELEASE, 'source', `coloradapt-source-${version}.zip`);
const tree = path.join(work, 'src');
for (const [name, data] of readZip(readFileSync(sourceZip))) {
  const file = path.join(tree, ...name.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: tree,
    stdio: 'inherit',
    shell: command === pnpm && process.platform === 'win32',
    ...options,
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
}
run(pnpm, ['install', '--frozen-lockfile', ...(argv.includes('--offline') ? ['--offline'] : [])]);
const out = path.join(work, 'out');
run(process.execPath, ['scripts/release/package.mjs', '--no-source', '--out', out]);

let same = true;
for (const id of ['chrome', 'firefox']) {
  const rel = `${id}/coloradapt-${id}-${version}.zip`;
  const rebuilt = sha256(readFileSync(path.join(out, rel)));
  const submitted = sha256(readFileSync(path.join(RELEASE, rel)));
  console.log(
    `${rebuilt === submitted ? 'IDENTICAL' : 'DIFFERENT'} ${rel}\n  rebuilt   ${rebuilt}\n  submitted ${submitted}`,
  );
  if (rebuilt !== submitted) same = false;
}
console.log(same ? 'REBUILD PASS: both archives are byte-identical' : 'REBUILD FAIL');
process.exit(same ? 0 : 1);
