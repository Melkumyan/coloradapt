#!/usr/bin/env node
/**
 * M12 secret scan (docs/m12/protocol.md, P33). ColorAdapt had no secret scanner before M12; this is the
 * canonical one from now on. It scans, as text:
 *   1. every file git tracks (`git ls-files`), plus untracked files that are not ignored;
 *   2. every file inside the built bundles (`dist/chrome-mv3`, `dist/firefox-mv2`);
 *   3. every file inside the release zips (`dist/*.zip`, read in memory).
 *
 * A finding is a credential-shaped string, a private key, a private-network endpoint, or the name of a
 * local user folder. Findings are classified by docs/m12/secret-scan-allowlist.json (a reviewed list of
 * { file, rule, reason[, match] }: test fixtures that plant fake secrets on purpose; `match`, when present,
 * narrows the entry to that exact matched host, without the scheme); anything not listed fails.
 *
 * Usage: node scripts/release/secret-scan.mjs [--json out.json]
 */
import { spawnSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : undefined;
const ALLOW = JSON.parse(
  readFileSync(path.join(ROOT, 'docs', 'm12', 'secret-scan-allowlist.json'), 'utf8'),
).entries;

const RULES = [
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private-key-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['llm-api-key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  [
    'assigned-secret',
    /\b(?:api[_-]?key|secret|passwd|password|auth[_-]?token|access[_-]?token|bearer)\b["']?\s*[:=]\s*["'][A-Za-z0-9/+_=.-]{20,}["']/i,
  ],
  [
    'private-network-endpoint',
    /https?:\/\/(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.(?:internal|corp|local|lan))\b/i,
  ],
  [
    'local-user-folder',
    /[A-Za-z]:[\\/]+Users[\\/]+(?!Public|Default|<|\.\.\.|\{|%|\*|name|user|you)[A-Za-z0-9._-]+/,
  ],
  [
    'unix-home-folder',
    /\/(?:home|Users)\/(?!user\b|name\b|you\b|runner\b|<|\{|\*|\.\.\.|Shared|Public)[a-z][a-z0-9._-]{2,}\//,
  ],
  [
    'email-address',
    /\b[A-Za-z0-9._%+-]+@(?:gmail|outlook|yahoo|hotmail|proton|icloud)\.[a-z]{2,}\b/i,
  ],
];

const SKIP_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.zip',
  '.pdf',
]);
const SKIP_PREFIX = ['pnpm-lock.yaml'];
const MAX_BYTES = 8 * 1024 * 1024;

function git(...args) {
  const run = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
  return run.stdout.split('\n').filter(Boolean);
}

/** Entries of a zip file (stored or deflated), read from its central directory. */
function readZip(file) {
  const buf = readFileSync(file);
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error(`not a zip file: ${file}`);
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`bad central directory: ${file}`);
    const method = buf.readUInt16LE(at + 10);
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
    out.push({ name, data: method === 0 ? raw : inflateRawSync(raw) });
  }
  return out;
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const targets = []; // { label, file }
for (const rel of new Set([
  ...git('ls-files'),
  ...git('ls-files', '--others', '--exclude-standard'),
])) {
  const file = path.join(ROOT, rel);
  if (existsSync(file) && statSync(file).isFile()) targets.push({ label: rel, file });
}
for (const name of ['chrome-mv3', 'firefox-mv2']) {
  const dir = path.join(ROOT, 'dist', name);
  if (existsSync(dir))
    for (const f of walk(dir))
      targets.push({
        label: `dist/${name}/${path.relative(dir, f).split(path.sep).join('/')}`,
        file: f,
      });
}
const zipEntries = []; // { label, text }
const distDir = path.join(ROOT, 'dist');
if (existsSync(distDir)) {
  for (const zip of readdirSync(distDir).filter(
    (n) => n.endsWith('.zip') && !n.endsWith('-sources.zip'),
  )) {
    for (const entry of readZip(path.join(distDir, zip))) {
      zipEntries.push({ label: `dist/${zip}!/${entry.name}`, text: entry.data.toString('utf8') });
    }
  }
}
// M13: the store upload archives and the AMO source archive (release/m13), read in memory.
const releaseDir = path.join(ROOT, 'release', 'm13');
if (existsSync(releaseDir)) {
  for (const f of walk(releaseDir)) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (f.endsWith('.zip')) {
      for (const entry of readZip(f))
        zipEntries.push({ label: `${rel}!/${entry.name}`, text: entry.data.toString('utf8') });
    } else if (/\.(json|md|txt)$|SHA256SUMS$/.test(f) && statSync(f).size <= 2_000_000) {
      zipEntries.push({ label: rel, text: readFileSync(f, 'utf8') });
    }
  }
}

const findings = [];
const classified = [];
let scanned = 0;
const texts = [
  ...targets.flatMap(({ label, file }) =>
    SKIP_EXT.has(path.extname(file).toLowerCase()) ||
    SKIP_PREFIX.some((p) => label.startsWith(p)) ||
    statSync(file).size > MAX_BYTES
      ? []
      : [{ label, text: readFileSync(file, 'utf8') }],
  ),
  ...zipEntries,
];
for (const { label, text } of texts) {
  scanned += 1;
  for (const [rule, pattern] of RULES) {
    const global = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
    for (const match of text.matchAll(global)) {
      const line = text.slice(0, match.index).split('\n').length;
      const hit = {
        file: label,
        rule,
        line,
        sample: `${match[0].slice(0, 6)}…(${match[0].length} chars)`,
      };
      // an entry with `match` classifies only that exact matched text, not the whole rule in the file
      const allowed = ALLOW.find(
        (a) =>
          a.rule === rule &&
          (label.startsWith(a.file) ||
            (label.includes('.zip!/') && label.split('.zip!/')[1].startsWith(a.file))) &&
          (a.match === undefined || a.match === match[0].replace(/^https?:\/\//, '')),
      );
      (allowed ? classified : findings).push(allowed ? { ...hit, reason: allowed.reason } : hit);
    }
  }
}

console.log(
  `scanned ${scanned} files (${targets.length} candidates); classified false positives: ${classified.length}; findings: ${findings.length}`,
);
for (const f of findings) console.error(`FINDING ${f.rule} ${f.file}:${f.line} ${f.sample}`);
if (jsonOut)
  writeFileSync(jsonOut, `${JSON.stringify({ scanned, classified, findings }, null, 2)}\n`);
process.exit(findings.length === 0 ? 0 : 1);
