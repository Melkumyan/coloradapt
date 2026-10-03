import { DEFAULT_USER_SETTINGS, type UserSettings } from '@domain/models';
import { createDynamicContentController } from '@features/dynamic-analysis';
import type { DynamicContentController } from '@features/dynamic-analysis';
import { CUE_ATTRIBUTE, defaultFactsEnvironment, type FactsEnvironment } from '@features/semantics';
import { createManualScheduler } from '../dynamic/helpers';

export { createManualScheduler, microtasks } from '../dynamic/helpers';
export { CUE_ATTRIBUTE };

export const SETTINGS: UserSettings = {
  ...DEFAULT_USER_SETTINGS,
  visionProfile: 'deuteranopia',
  adaptationStrength: 1,
};

/**
 * jsdom cannot compute pseudo-element styles, so the "browser" is simulated for exactly one
 * thing: what ends up in `::before` / `::after`. The page's own content is declared with
 * `data-test-before` / `data-test-after`; a ColorAdapt cue shows up only when the cue stylesheet
 * is actually in effect and has a rule for the element's cue key. Everything else (computed
 * styles, selectors, the cascade, `!important`) is jsdom's own.
 */
export function simulatedBrowser(doc: Document = document): FactsEnvironment {
  const base = defaultFactsEnvironment(doc);
  return {
    view: base.view,
    pseudoContent(element, pseudo) {
      const own = element.getAttribute(`data-test-${pseudo === '::before' ? 'before' : 'after'}`);
      if (own !== null) return `"${own}"`;
      const key = element.getAttribute(CUE_ATTRIBUTE);
      const sheet = doc.getElementById('coloradapt-stylesheet')?.textContent ?? '';
      if (key) {
        // `content:"\2713 "` is text; `content:""` is a shape. Both are real content.
        const match = new RegExp(
          `\\[${CUE_ATTRIBUTE}="${key}"\\]${pseudo}\\{content:(?:"\\\\([0-9a-f]+) "|"")`,
        ).exec(sheet);
        if (match) {
          const text = match[1] ? String.fromCodePoint(Number.parseInt(match[1], 16)) : '';
          return `"${text}" / ""`;
        }
      }
      return 'none';
    },
  };
}

export interface Rig {
  readonly controller: DynamicContentController;
  readonly scheduler: ReturnType<typeof createManualScheduler>;
  /** Processes everything pending now. */
  flush(): ReturnType<DynamicContentController['dynamic']['flush']>;
  refresh(settings?: UserSettings): void;
}

let current: DynamicContentController | null = null;

/** Mounts `markup` (with a `<style>` for the page's CSS) and enables adaptation. */
export function mount(markup: string, css = '', settings: UserSettings = SETTINGS): Rig {
  document.head.innerHTML = css ? `<style id="page-css">${css}</style>` : '';
  document.body.innerHTML = markup;
  const scheduler = createManualScheduler();
  const controller = createDynamicContentController(
    document,
    { now: () => 0 },
    { scheduler },
    { env: simulatedBrowser(document) },
  );
  current = controller;
  controller.enableAdaptation('https://example.com', settings);
  return {
    controller,
    scheduler,
    flush: () => controller.dynamic.flush(),
    refresh: (next = settings) => {
      controller.enableAdaptation('https://example.com', next);
    },
  };
}

export function teardown(): void {
  current?.dynamic.dispose();
  current?.disableAdaptation();
  current = null;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
}

export const $ = (selector: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`no element matches ${selector}`);
  return node;
};

export const cueOf = (selector: string): string | null => $(selector).getAttribute(CUE_ATTRIBUTE);

export const cueCount = (): number => document.querySelectorAll(`[${CUE_ATTRIBUTE}]`).length;

export const sheetText = (): string =>
  document.getElementById('coloradapt-stylesheet')?.textContent ?? '';

/** A cue key as the stylesheet knows it, for readable assertions: `after:2715` -> `after ✓`. */
export function describeCue(key: string | null): string | null {
  if (!key) return null;
  const [placement, hex] = key.split(':');
  if (placement === 'after' || placement === 'before' || placement === 'inner') {
    return `${placement} ${String.fromCodePoint(Number.parseInt(hex!, 16))}`;
  }
  return key;
}
