import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseColor } from '@core/color';
import { analyzePixels } from '@core/images';
import { simulatePair } from '@core/vision';
import { DEFAULT_USER_SETTINGS, type UserSettings, type VisionProfile } from '@domain/models';
import { createContentController } from '@features/page-analysis';
import { FakeImageEnvironment, PNG_BYTES } from '../features/images/fake-env';
import { setDecoded } from '../features/images/kit';
import { IMAGE_SCENARIOS, type Category, type ImageScenario } from './image-scenarios';

/**
 * Image benchmark (docs/IMAGE_ADAPTATION.md, "Benchmark"): every scenario goes through the real
 * controller (jsdom, a fake image environment standing in for the browser's decoder and canvas).
 * Assertions are structural: what the image layer did with each image, never how it looks.
 * Real-browser confirmation of the same behaviors is in e2e/image-*.spec.ts.
 *
 * The hard gate: zero transformations in the `false-positive` group.
 */
const REPORT_DIR = path.resolve(import.meta.dirname, '../../benchmark-report');
const PROFILES: readonly VisionProfile[] = ['protanopia', 'deuteranopia', 'tritanopia'];

interface Row {
  readonly id: string;
  readonly category: Category;
  readonly group: string;
  readonly profile: VisionProfile;
  readonly action: string;
  readonly reason: string;
  readonly kind: string;
  readonly confidence: string;
  readonly transformed: boolean;
  readonly distinguishabilityBefore: number | null;
  readonly distinguishabilityAfter: number | null;
  readonly geometryPreserved: boolean | null;
  /** Stated expectation about the decision itself was not met (never true when the suite passes). */
  readonly conflict: boolean;
}

/** Categories that are never recolored: any transformed row in one is a hard failure. */
const PROTECTED: ReadonlySet<string> = new Set([
  'photograph',
  'logo',
  'brand-ambiguity',
  'artwork',
  'screenshot',
  'raster-chart',
  'animated',
  'cross-origin-unreadable',
  'status-graphic',
  'decorative',
  'diagram',
]);

const rows: Row[] = [];
const diagnosticsByProfile: Record<string, unknown> = {};

function settingsFor(profile: VisionProfile): UserSettings {
  return {
    ...DEFAULT_USER_SETTINGS,
    visionProfile: profile,
    adaptationStrength: 1,
    adaptImages: true,
    semanticCuesEnabled: false,
    adaptCharts: false,
    adaptSVG: false,
    improveUIColors: false,
    improveLinks: false,
    improveStatusIndicators: false,
  };
}

function mount(scenario: ImageScenario, host: HTMLElement): HTMLImageElement {
  const wrapperSpec = scenario.wrapper ?? { tag: 'div' as const };
  const wrapper = document.createElement(wrapperSpec.tag);
  wrapper.setAttribute('style', `background-color: ${scenario.background}`);
  if (wrapperSpec.className) wrapper.setAttribute('class', wrapperSpec.className);
  if (wrapperSpec.href) wrapper.setAttribute('href', wrapperSpec.href);
  for (const [name, value] of Object.entries(wrapperSpec.attrs ?? {})) {
    wrapper.setAttribute(name, value);
  }
  const img = document.createElement('img');
  for (const [name, value] of Object.entries(scenario.attrs ?? {})) img.setAttribute(name, value);
  img.setAttribute('src', scenario.src);
  const pixels = typeof scenario.resource === 'string' ? null : scenario.resource;
  const natural = scenario.natural ?? { width: pixels?.width ?? 24, height: pixels?.height ?? 24 };
  setDecoded(img, natural.width, natural.height);
  wrapper.append(img);
  host.append(wrapper);
  return img;
}

function dominant(buffer: { width: number; height: number; data: Uint8ClampedArray }) {
  return analyzePixels(buffer).clusters.find((cluster) => !cluster.neutral)?.color ?? null;
}

describe('image benchmark', () => {
  it('has at least 175 scenarios across every required category', () => {
    expect(IMAGE_SCENARIOS.length).toBeGreaterThanOrEqual(175);
    const ids = IMAGE_SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    const categories = new Set(IMAGE_SCENARIOS.map((scenario) => scenario.category));
    for (const required of [
      'photograph',
      'logo',
      'decorative',
      'monochrome-icon',
      'status-graphic',
      'diagram',
      'raster-chart',
      'screenshot',
      'cross-origin-unreadable',
      'same-origin-readable',
      'animated',
      'large-image',
      'transparent-png',
      'brand-ambiguity',
      'functional-icon',
      'artwork',
      'boundary',
      'responsive',
    ] as const) {
      expect(categories.has(required)).toBe(true);
    }
  });

  for (const profile of PROFILES) {
    describe(`profile ${profile}`, () => {
      const scenarios = IMAGE_SCENARIOS.filter((scenario) => scenario.profile === profile);

      it('every scenario ends in the stated state, and nothing leaks', async () => {
        document.body.innerHTML = '<div id="host"></div>';
        const host = document.getElementById('host')!;
        const env = new FakeImageEnvironment();
        const originals = new Map<string, string>();
        const images = new Map<string, HTMLImageElement>();
        for (const scenario of scenarios) {
          env.set(scenario.src, scenario.resource);
          if (scenario.bytes) env.bytes.set(scenario.src, scenario.bytes);
          const img = mount(scenario, host);
          images.set(scenario.id, img);
          originals.set(scenario.id, img.getAttribute('src')!);
        }
        void PNG_BYTES;
        const controller = createContentController(document, { now: () => 0 }, { imageEnv: env });
        controller.enableAdaptation('https://example.com', settingsFor(profile));
        await controller.settleImages();

        const failures: string[] = [];
        for (const scenario of scenarios) {
          const img = images.get(scenario.id)!;
          const info = controller.inspectImage(img);
          const transformed = img.getAttribute('src') !== originals.get(scenario.id);
          const wants = scenario.expect;
          if (!info) {
            failures.push(`${scenario.id}: not tracked`);
            continue;
          }
          if (info.action !== wants.action)
            failures.push(
              `${scenario.id}: action ${info.action}/${info.reason}, wanted ${wants.action}`,
            );
          else if (wants.reason && info.reason !== wants.reason)
            failures.push(`${scenario.id}: reason ${info.reason}, wanted ${wants.reason}`);
          if (wants.kind && info.kind !== wants.kind)
            failures.push(`${scenario.id}: kind ${info.kind}, wanted ${wants.kind}`);
          if (transformed !== (wants.action === 'pixel-adapted'))
            failures.push(`${scenario.id}: transformed=${String(transformed)}`);
          if (scenario.group === 'false-positive' && transformed)
            failures.push(`${scenario.id}: FALSE-POSITIVE TRANSFORM`);

          let before: number | null = null;
          let after: number | null = null;
          let geometry: boolean | null = null;
          if (transformed && typeof scenario.resource !== 'string') {
            const generated = env.pixelsOf(img.getAttribute('src')!)!;
            const original = scenario.resource;
            geometry =
              generated.width === original.width &&
              generated.height === original.height &&
              original.data.every(
                (value, index) => index % 4 !== 3 || generated.data[index] === value,
              );
            const bg = parseColor(scenario.background)!;
            const from = dominant(original)!;
            const to = dominant(generated)!;
            before = simulatePair(from, bg, profile).simulatedDistance;
            after = simulatePair(to, bg, profile).simulatedDistance;
            if (!(after > before))
              failures.push(`${scenario.id}: distinguishability ${before} -> ${after}`);
            if (!geometry) failures.push(`${scenario.id}: geometry changed`);
          }
          rows.push({
            id: scenario.id,
            category: scenario.category,
            group: scenario.group,
            profile,
            action: info.action,
            reason: info.reason,
            kind: info.kind,
            confidence: info.confidence,
            transformed,
            distinguishabilityBefore: before,
            distinguishabilityAfter: after,
            geometryPreserved: geometry,
            conflict: failures.some((failure) => failure.startsWith(`${scenario.id}:`)),
          });
        }
        expect(failures).toEqual([]);

        // Idempotent refresh: a second and a third full pass change nothing and create nothing.
        const created = env.created.length;
        const srcs = [...images.values()].map((img) => img.getAttribute('src'));
        for (let i = 0; i < 2; i += 1) {
          controller.enableAdaptation('https://example.com', settingsFor(profile));
          await controller.settleImages();
        }
        expect(env.created).toHaveLength(created);
        expect([...images.values()].map((img) => img.getAttribute('src'))).toEqual(srcs);

        diagnosticsByProfile[profile] = controller.incremental.imageDiagnostics();
        const diagnostics = controller.incremental.imageDiagnostics();
        expect(diagnostics.pendingReads).toBe(0);
        expect(diagnostics.queuedImages).toBe(0);
        expect(diagnostics.ownedUrls).toBe(diagnostics.imageOwners);

        controller.disableAdaptation();
        expect(env.live).toEqual([]);
        for (const scenario of scenarios) {
          expect(images.get(scenario.id)!.getAttribute('src')).toBe(originals.get(scenario.id));
          expect(images.get(scenario.id)!.hasAttribute('data-coloradapt-image')).toBe(false);
        }
      });
    });
  }

  afterAll(() => {
    const countBy = (predicate: (row: Row) => boolean) => rows.filter(predicate).length;
    const falsePositives = rows.filter((row) => row.group === 'false-positive');
    const supportedRows = rows.filter((row) => row.group === 'supported');
    const summary = {
      cases: rows.length,
      photos: countBy((row) => row.category === 'photograph'),
      logos: countBy((row) => row.category === 'logo'),
      functional: countBy((row) =>
        ['monochrome-icon', 'status-graphic', 'diagram', 'raster-chart'].includes(row.category),
      ),
      adapted: countBy((row) => row.transformed),
      unsupported: countBy((row) => row.action === 'unsupported'),
      unchanged: countBy((row) => row.action === 'unchanged'),
      notNeeded: countBy((row) => row.action === 'not-needed'),
      falsePositiveCases: falsePositives.length,
      falsePositiveTransforms: falsePositives.filter((row) => row.transformed).length,
      photosTransformed: countBy((row) => row.category === 'photograph' && row.transformed),
      logosTransformed: countBy(
        (row) => ['logo', 'brand-ambiguity'].includes(row.category) && row.transformed,
      ),
      protectedTransformed: countBy((row) => PROTECTED.has(row.category) && row.transformed),
      functionalIconsAdapted: countBy(
        (row) => row.category === 'functional-icon' && row.transformed,
      ),
      supportedMisses: countBy((row) => row.group === 'miss'),
      classificationConflicts: rows.filter((row) => row.conflict).length,
      supportedCases: supportedRows.length,
      supportedAdapted: supportedRows.filter((row) => row.transformed).length,
      supportedClassifiedHigh: supportedRows.filter(
        (row) => row.kind === 'monochrome-icon' && row.confidence === 'HIGH',
      ).length,
      supportedImproved: supportedRows.filter(
        (row) => (row.distinguishabilityAfter ?? 0) > (row.distinguishabilityBefore ?? Infinity),
      ).length,
      supportedGeometryPreserved: supportedRows.filter((row) => row.geometryPreserved === true)
        .length,
    };
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(
      path.join(REPORT_DIR, 'images.json'),
      JSON.stringify(
        { generatedBy: 'tests/benchmarks', summary, diagnosticsByProfile, rows },
        null,
        2,
      ),
    );
  });

  it('the gates hold across every profile (zero false-positive transforms, supported cases all adapted)', () => {
    // Runs after the profile suites above (same file, sequential).
    const falsePositives = rows.filter((row) => row.group === 'false-positive');
    expect(falsePositives.length).toBeGreaterThanOrEqual(100);
    expect(falsePositives.filter((row) => row.transformed)).toEqual([]);
    const supportedRows = rows.filter((row) => row.group === 'supported');
    expect(supportedRows.length).toBeGreaterThanOrEqual(15);
    expect(supportedRows.every((row) => row.transformed)).toBe(true);
    expect(supportedRows.every((row) => row.geometryPreserved === true)).toBe(true);
    expect(rows.filter((row) => PROTECTED.has(row.category) && row.transformed)).toEqual([]);
    expect(rows.filter((row) => row.group === 'miss' && row.transformed)).toEqual([]);
    expect(rows.filter((row) => row.category === 'photograph' && row.transformed)).toEqual([]);
    expect(rows.filter((row) => row.category === 'logo' && row.transformed)).toEqual([]);
    expect(rows.filter((row) => row.category === 'raster-chart' && row.transformed)).toEqual([]);
  });
});
