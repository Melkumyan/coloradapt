#!/usr/bin/env node
/**
 * M12 build reproducibility check (docs/m12/protocol.md, P32). For each target it builds twice from the same
 * tree, compares the two output folders file by file (SHA-256) and, with `--zip`, packages twice and compares
 * the archives both as bytes and as contents (entry names and entry hashes), so that a difference caused by
 * archive metadata (timestamps) is told apart from a difference in what ships.
 *
 * Usage: node scripts/release/repro-check.mjs [--zip] [--json out.json]
 *
 * Writes into `dist/` like the normal builds; run it on a clean working tree.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const withZip = argv.includes('--zip');
const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : undefined;
const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const TARGETS = [
  {
    name: 'chrome',
    outDir: 'chrome-mv3',
    build: ['build'],
    zip: ['zip'],
    zipName: `coloradapt-${version}-chrome.zip`,
  },
  {
    name: 'firefox',
    outDir: 'firefox-mv2',
    build: ['build', '-b', 'firefox'],
    zip: ['zip', '-b', 'firefox'],
    zipName: `coloradapt-${version}-firefox.zip`,
  },
];

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

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

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const folderHashes = (dir) =>
  Object.fromEntries(
    walk(dir)
      .map((f) => [path.relative(dir, f).split(path.sep).join('/'), sha(readFileSync(f))])
      .sort(([a], [b]) => a.localeCompare(b)),
  );

function zipEntries(file) {
  const buf = readFileSync(file);
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end -= 1;
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = {};
  const stamps = [];
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(at + 10);
    stamps.push(`${buf.readUInt16LE(at + 12)}/${buf.readUInt16LE(at + 14)}`); // dos time/date
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + size);
    out[name] = sha(method === 0 ? raw : inflateRawSync(raw));
  }
  return { entries: out, stamps: [...new Set(stamps)] };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const report = [];
let failed = false;

for (const t of TARGETS) {
  const folders = [];
  const zips = [];
  for (let run = 1; run <= 2; run += 1) {
    wxt(t.build);
    folders.push(folderHashes(path.join(ROOT, 'dist', t.outDir)));
    if (withZip) {
      wxt(t.zip);
      const file = path.join(ROOT, 'dist', t.zipName);
      zips.push({ bytes: sha(readFileSync(file)), size: statSync(file).size, ...zipEntries(file) });
    }
  }
  const result = {
    target: t.name,
    files: Object.keys(folders[0]).length,
    folderIdentical: same(folders[0], folders[1]),
    differingFiles: Object.keys(folders[0]).filter((f) => folders[0][f] !== folders[1][f]),
  };
  if (withZip) {
    result.zip = {
      bytesIdentical: zips[0].bytes === zips[1].bytes,
      contentsIdentical: same(zips[0].entries, zips[1].entries),
      sha256: [zips[0].bytes, zips[1].bytes],
      size: zips[0].size,
      entryTimestamps: [zips[0].stamps, zips[1].stamps],
    };
  }
  report.push(result);
  if (!result.folderIdentical || (withZip && !result.zip.contentsIdentical)) failed = true;
  console.log(JSON.stringify(result));
}
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
if (!existsSync(path.join(ROOT, 'dist'))) failed = true;
process.exit(failed ? 1 : 0);
