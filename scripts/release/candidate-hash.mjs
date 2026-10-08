#!/usr/bin/env node
/**
 * M12 (docs/m12/protocol.md): the identity of the certification candidate. A SHA-256 over the path and the content of
 * every file that can change what ships or how it is certified: all tracked and untracked (not ignored) files
 * except the prose that reports on the candidate (Markdown, and the lockfile's formatting). The frozen value is
 * written in the protocol and checked before and after every formal run: a run on a changed tree is not evidence.
 *
 * Usage: node scripts/release/candidate-hash.mjs [--list]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function git(...args) {
  const run = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
  return run.stdout.split('\n').filter(Boolean);
}

const excluded = (rel) =>
  rel.endsWith('.md') ||
  rel.startsWith('realworld/.artifacts/') ||
  rel.startsWith('test-results/') ||
  rel.startsWith('benchmark-report/');

const files = [
  ...new Set([...git('ls-files'), ...git('ls-files', '--others', '--exclude-standard')]),
]
  .filter((rel) => !excluded(rel))
  .filter((rel) => existsSync(path.join(ROOT, rel)) && statSync(path.join(ROOT, rel)).isFile())
  .sort();

const hash = createHash('sha256');
for (const rel of files) {
  // line endings are the checkout's business (git autocrlf), not the candidate's
  const text = readFileSync(path.join(ROOT, rel)).toString('latin1').replaceAll('\r\n', '\n');
  hash.update(`${rel}\0${createHash('sha256').update(text, 'latin1').digest('hex')}\n`);
}
if (process.argv.includes('--list')) for (const f of files) console.log(f);
console.log(`candidate ${hash.digest('hex')} (${files.length} files)`);
