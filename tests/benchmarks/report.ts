import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { VisionProfile } from '@domain/models';
import { simulatePair } from '@core/vision';
import { aggregate, parseHex, type BenchmarkAggregate, type BenchmarkRow } from './run-benchmark';

export interface BenchmarkReport {
  readonly generatedBy: 'tests/benchmarks';
  readonly note: string;
  readonly profiles: readonly VisionProfile[];
  readonly aggregate: BenchmarkAggregate;
  readonly byProfile: Readonly<Record<string, BenchmarkAggregate>>;
  readonly rows: readonly BenchmarkRow[];
}

const NOTE =
  'Diagnostics only. Distances are M2 simulated OKLab distances; anomaly profiles depend on the ' +
  'M2 MODEL_ASSUMPTION. Nothing here judges how a result looks.';

export function buildReport(
  profiles: readonly VisionProfile[],
  rows: readonly BenchmarkRow[],
): BenchmarkReport {
  return {
    generatedBy: 'tests/benchmarks',
    note: NOTE,
    profiles,
    aggregate: aggregate(rows),
    byProfile: Object.fromEntries(
      profiles.map((profile) => [
        profile,
        aggregate(rows.filter((row) => row.profile === profile)),
      ]),
    ),
    rows,
  };
}

function swatch(fg: string, bg: string, label: string): string {
  return `<span class="sw" style="color:${fg};background:${bg}" title="${label}">Aa 123</span>`;
}

function simulatedHex(row: BenchmarkRow, foreground: string): [string, string] {
  const analysis = simulatePair(parseHex(foreground), parseHex(row.background), row.profile);
  const toCss = (c: { r: number; g: number; b: number }): string =>
    `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
  return [toCss(analysis.simulatedForeground), toCss(analysis.simulatedBackground)];
}

function fmt(value: number | null, digits = 3): string {
  return value === null ? '–' : value.toFixed(digits);
}

/** Self-contained before/after HTML: normal vision and simulated, per row. */
export function renderHtml(report: BenchmarkReport): string {
  const lines = report.rows.map((row) => {
    const changed = row.status === 'adapted';
    const [origSimFg, origSimBg] = simulatedHex(row, row.foreground);
    const [newSimFg, newSimBg] = simulatedHex(row, row.output);
    return `<tr class="${row.status}">
  <td>${row.pairId}</td><td>${row.profile}</td><td>${row.status}</td>
  <td>${swatch(row.foreground, row.background, 'before')}<br><code>${row.foreground}</code></td>
  <td>${changed ? swatch(row.output, row.background, 'after') + `<br><code>${row.output}</code>` : '–'}</td>
  <td>${swatch(origSimFg, origSimBg, 'before, simulated')}</td>
  <td>${changed ? swatch(newSimFg, newSimBg, 'after, simulated') : '–'}</td>
  <td>${fmt(row.originalSimulatedDistance)} → ${fmt(row.adaptedSimulatedDistance)}</td>
  <td>${fmt(row.originalContrast, 2)} → ${fmt(row.adaptedContrast, 2)}</td>
  <td>${fmt(row.designChange)}</td><td>${row.candidateCount}</td><td>${row.selectedStage ?? '–'}</td>
</tr>`;
  });
  const agg = report.aggregate;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ColorAdapt adaptation benchmark</title>
<style>
body{font:14px sans-serif;margin:16px;background:#fff;color:#111}
table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top}
.sw{display:inline-block;padding:4px 10px;font-weight:600}
tr.unchanged{opacity:.55}tr.no-safe-candidate td:nth-child(3){color:#b00}code{font-size:12px}
</style></head><body>
<h1>Adaptation benchmark</h1>
<p>${report.note}</p>
<p>rows ${agg.rows} · adapted ${agg.adapted} · unchanged ${agg.unchanged} · no-safe-candidate ${agg.noSafeCandidate}
 · median design change ${fmt(agg.medianDesignChange)} · hard violations ${agg.hardViolations}</p>
<table><thead><tr><th>pair</th><th>profile</th><th>status</th><th>before</th><th>after</th>
<th>before (simulated)</th><th>after (simulated)</th><th>sim. distance</th><th>contrast</th>
<th>design change</th><th>candidates</th><th>stage</th></tr></thead>
<tbody>
${lines.join('\n')}
</tbody></table></body></html>`;
}

/** Writes `adaptation-benchmark.json` and `.html` into `dir` (gitignored build output). */
export function writeReport(dir: string, report: BenchmarkReport): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'adaptation-benchmark.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync(path.join(dir, 'adaptation-benchmark.html'), renderHtml(report));
}
