import { afterEach } from 'vitest';
import { DEFAULT_USER_SETTINGS, type UserSettings } from '@domain/models';
import type { PixelBuffer } from '@core/images';
import { createContentController } from '@features/page-analysis';
import { createDynamicContentController } from '@features/dynamic-analysis';
import { FakeImageEnvironment } from './fake-env';
import { createManualScheduler } from '../dynamic/helpers';
import { hex, monoIcon, photograph } from '../../core/images/pixels';

export const IMAGE_SETTINGS: UserSettings = {
  ...DEFAULT_USER_SETTINGS,
  visionProfile: 'deuteranopia',
  adaptationStrength: 1,
  adaptImages: true,
  // Only the image layer is under test: other layers stay off so they cannot hide a bug.
  semanticCuesEnabled: false,
  adaptCharts: false,
  adaptSVG: false,
  improveUIColors: false,
  improveLinks: false,
  improveStatusIndicators: false,
};

export const GREEN = '#2ca02c';
export const RED = hex('#d62728');

export interface ImageSpec {
  readonly src: string;
  readonly width?: number;
  readonly height?: number;
  readonly attrs?: Record<string, string>;
  /** `false` leaves the image "still loading" (`complete === false`). */
  readonly complete?: boolean;
}

export function abs(path: string): string {
  return new URL(path, document.baseURI).href;
}

/** Creates an `<img>` that looks decoded to the controller (jsdom never decodes anything). */
export function makeImage(spec: ImageSpec): HTMLImageElement {
  const img = document.createElement('img');
  for (const [name, value] of Object.entries(spec.attrs ?? {})) img.setAttribute(name, value);
  img.setAttribute('src', spec.src);
  setDecoded(img, spec.width ?? 24, spec.height ?? 24, spec.complete ?? true);
  return img;
}

export function setDecoded(
  img: HTMLImageElement,
  width: number,
  height: number,
  complete = true,
): void {
  Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true });
  Object.defineProperty(img, 'complete', { value: complete, configurable: true });
}

/** The page changes `src` the way a script does, then the browser reports the load. */
export function pageSetsSrc(img: HTMLImageElement, src: string, width = 24, height = 24): void {
  img.setAttribute('src', src);
  setDecoded(img, width, height, true);
  img.dispatchEvent(new Event('load'));
}

export function fire(img: Element, type: 'load' | 'error'): void {
  img.dispatchEvent(new Event(type));
}

export function iconPixels(color = RED, size = 24): PixelBuffer {
  return monoIcon(size, color, false);
}

export { photograph };

export interface Kit {
  readonly env: FakeImageEnvironment;
  readonly controller: ReturnType<typeof createContentController>;
  settle(): Promise<void>;
  enable(settings?: Partial<UserSettings>): void;
}

let live: Array<() => void> = [];

afterEach(() => {
  for (const stop of live) stop();
  live = [];
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.body.removeAttribute('style');
});

/** A document with `markup`, a content controller wired to a fake image environment. */
export function setup(markup: string, options: { background?: string } = {}): Kit {
  document.body.innerHTML = markup;
  document.body.setAttribute('style', `background-color: ${options.background ?? GREEN}`);
  const env = new FakeImageEnvironment();
  const controller = createContentController(document, { now: () => 0 }, { imageEnv: env });
  live.push(() => controller.disableAdaptation());
  return {
    env,
    controller,
    settle: () => controller.settleImages(),
    enable(settings = {}) {
      controller.enableAdaptation('https://example.com', { ...IMAGE_SETTINGS, ...settings });
    },
  };
}

/** The same, with the M4 pipeline around it (manual scheduler). */
export function setupDynamic(markup: string, options: { background?: string } = {}) {
  document.body.innerHTML = markup;
  document.body.setAttribute('style', `background-color: ${options.background ?? GREEN}`);
  const env = new FakeImageEnvironment();
  const scheduler = createManualScheduler();
  const controller = createDynamicContentController(
    document,
    { now: () => 0 },
    { scheduler },
    { imageEnv: env },
  );
  live.push(() => {
    controller.dynamic.dispose();
    controller.disableAdaptation();
  });
  return {
    env,
    controller,
    scheduler,
    settle: () => controller.settleImages(),
    enable(settings: Partial<UserSettings> = {}) {
      controller.enableAdaptation('https://example.com', { ...IMAGE_SETTINGS, ...settings });
    },
  };
}
