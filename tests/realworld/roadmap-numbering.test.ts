import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * M10.R1: one canonical roadmap. A future-looking reference to a milestone must carry the number the roadmap
 * gives it. (M0-M9 and the tags of frozen milestones are history and are not touched.)
 */
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CANONICAL: Array<[number, string]> = [
  [10, 'Real-World Validation'],
  [11, 'AI Semantic Engine'],
  [12, 'Production Hardening'],
  [13, 'Store Release'],
  [14, 'Advanced Product'],
];

function files(): string[] {
  const docs = readdirSync(path.join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join('docs', f));
  return [...docs, 'README.md', 'wxt.config.ts'];
}

const lines = files().flatMap((file) =>
  readFileSync(path.join(ROOT, file), 'utf8')
    .split('\n')
    .map((text, i) => ({ file, line: i + 1, text })),
);

describe('roadmap numbering', () => {
  it('docs/ROADMAP.md has one heading per milestone, in the canonical numbering', () => {
    const roadmap = readFileSync(path.join(ROOT, 'docs', 'ROADMAP.md'), 'utf8');
    for (const [n, name] of CANONICAL) {
      expect(roadmap, `M${n}`).toMatch(new RegExp(`^## M${n} — ${name}`, 'm'));
    }
    expect(roadmap).toMatch(/^## M10\.R1 — /m);
  });

  it('every "M<n> <name>" pairing in the docs uses the canonical number', () => {
    const names = CANONICAL.map(([, name]) => name).join('|');
    const pairing = new RegExp(String.raw`\bM(\d+)(?:\s+—\s+|,?\s+)(${names})`, 'g');
    let seen = 0;
    for (const { file, line, text } of lines) {
      for (const m of text.matchAll(pairing)) {
        seen++;
        const expected = CANONICAL.find(([, name]) => name === m[2])![0];
        expect(Number(m[1]), `${file}:${line}: ${text.trim()}`).toBe(expected);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(8);
  });

  it('a line about AI inference or the AI-assisted module points at M11, never at M10', () => {
    for (const { file, line, text } of lines) {
      if (!/AI inference|AI-assisted|AI semantic/i.test(text)) continue;
      const future = [...text.matchAll(/\bM(1\d)\b(?!\.)/g)].map((m) => Number(m[1]));
      // a line that lists the whole roadmap is an enumeration, checked by the pairing test above
      if (new Set(future).size >= 3) continue;
      expect(
        future.filter((n) => n !== 11),
        `${file}:${line}: ${text.trim()}`,
      ).toEqual([]);
    }
  });

  it('the permanent Firefox add-on id was decided by the store release validation (M13.R1)', () => {
    const config = readFileSync(path.join(ROOT, 'wxt.config.ts'), 'utf8');
    expect(config).toContain("id: 'coloradapt@melkumyan'");
    expect(config).toContain('owner-chosen canonical id for 0.1.0 (M13.R1)');
  });
});
