import type { ChartSeries, LegendItem, LegendMapping, LegendPair, MappingEvidence } from './types';

function tokenCounts<T>(
  entries: readonly T[],
  tokensOf: (entry: T) => readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const token of new Set(tokensOf(entry))) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/**
 * Pairs every series with its legend entry, or says it cannot be done. Evidence, strongest first:
 *
 * 1. `key`: the same `data-series` (or `data-key`, `data-name`) on the series and the swatch;
 * 2. `token`: a class token that names exactly one series and exactly one swatch (`series-b`;
 *    `legend-swatch` names them all, so it names none);
 * 3. `color`: the same paint, when exactly one series and exactly one swatch have it.
 *
 * Text is never matched by proximity, and order is never evidence on its own. A series that two
 * swatches could be, a swatch two series could be, or evidence that disagrees, makes the whole
 * mapping `ambiguous`: the caller then adapts nothing, because a legend that does not show what
 * the chart shows is worse than no adaptation.
 */
export function mapSeriesToLegend(
  series: readonly ChartSeries[],
  items: readonly LegendItem[],
): LegendMapping {
  if (items.length === 0) return { status: 'none' };
  if (series.length === 0) return { status: 'ambiguous', reason: 'no-match' };

  const seriesTokens = tokenCounts(series, (s) => s.classTokens);
  const itemTokens = tokenCounts(items, (item) => item.classTokens);
  const unique = (token: string) => seriesTokens.get(token) === 1 && itemTokens.get(token) === 1;

  const pairs: LegendPair[] = [];
  let unmapped = 0;
  for (const s of series) {
    const byKey = s.dataSeries ? items.filter((item) => item.dataSeries === s.dataSeries) : [];
    const byToken = items.filter((item) =>
      s.classTokens.some((token) => unique(token) && item.classTokens.includes(token)),
    );
    const byColor = items.filter((item) => item.paintKey !== null && item.paintKey === s.paintKey);
    const levels: Array<[MappingEvidence, readonly LegendItem[]]> = [
      ['key', byKey],
      ['token', byToken],
      ['color', byColor],
    ];
    const strongest = levels.find(([, found]) => found.length > 0);
    if (!strongest) {
      unmapped += 1;
      continue;
    }
    const [evidence, found] = strongest;
    if (found.length > 1) {
      return {
        status: 'ambiguous',
        reason: evidence === 'color' ? 'duplicate-color' : 'conflicting-evidence',
      };
    }
    const item = found[0] as LegendItem;
    // Keys on both sides that name different series outrank a shared color or token.
    if (s.dataSeries && item.dataSeries && s.dataSeries !== item.dataSeries) {
      return { status: 'ambiguous', reason: 'conflicting-evidence' };
    }
    // A weaker kind of evidence that points elsewhere (and only elsewhere) is a disagreement.
    for (const [, weaker] of levels) {
      if (weaker.length > 0 && !weaker.includes(item)) {
        return { status: 'ambiguous', reason: 'conflicting-evidence' };
      }
    }
    pairs.push({ seriesId: s.id, item, evidence });
  }

  if (pairs.length === 0) return { status: 'ambiguous', reason: 'no-match' };
  if (unmapped > 0) return { status: 'ambiguous', reason: 'partial' };
  const used = new Set(pairs.map((pair) => pair.item));
  if (used.size !== pairs.length) return { status: 'ambiguous', reason: 'duplicate-color' };
  return { status: 'mapped', pairs };
}
