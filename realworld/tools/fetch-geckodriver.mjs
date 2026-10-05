// Downloads the pinned geckodriver into realworld/.tools (git-ignored). Firefox itself is not downloaded:
// the real-world suite drives the Firefox installed on the machine (FIREFOX_BIN overrides the location).
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const VERSION = '0.37.1';
const dir = path.join(import.meta.dirname, '..', '.tools');
mkdirSync(dir, { recursive: true });
const win = process.platform === 'win32';
const target =
  process.platform === 'darwin'
    ? process.arch === 'arm64'
      ? 'macos-aarch64'
      : 'macos'
    : win
      ? 'win64'
      : 'linux64';
const ext = win ? 'zip' : 'tar.gz';
const file = path.join(dir, `geckodriver.${ext}`);
const binary = path.join(dir, win ? 'geckodriver.exe' : 'geckodriver');
if (existsSync(binary)) {
  console.log(`geckodriver already present: ${binary}`);
} else {
  const url = `https://github.com/mozilla/geckodriver/releases/download/v${VERSION}/geckodriver-v${VERSION}-${target}.${ext}`;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
  await pipeline(res.body, createWriteStream(file));
  execFileSync('tar', ['-xf', file, '-C', dir], { stdio: 'inherit' });
  rmSync(file);
  console.log(`installed ${binary}`);
}
