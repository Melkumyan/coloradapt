import type { AdaptationChange } from '@domain/models';
import { ELEMENT_ID_ATTRIBUTE } from '@core/analysis';

const STYLE_ELEMENT_ID = 'coloradapt-stylesheet';

function escapeAttributeValue(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

function buildRule(change: AdaptationChange): string {
  const selector = `[${ELEMENT_ID_ATTRIBUTE}="${escapeAttributeValue(change.elementId)}"]`;
  return `${selector} { ${change.property}: ${change.adaptedValue} !important; }`;
}

/**
 * Applies/restores adaptation changes via a single injected `<style>`
 * element, never inline styles. Restoring is just removing that element —
 * the page's own DOM and styles are never otherwise touched (aside from
 * the `data-coloradapt-id` attribute the DOM Analyzer adds for targeting).
 */
export class StylesheetManager {
  #doc: Document;
  #styleElement: HTMLStyleElement | null = null;

  constructor(doc: Document = document) {
    this.#doc = doc;
  }

  apply(changes: readonly AdaptationChange[]): void {
    if (changes.length === 0) {
      this.restore();
      return;
    }

    const styleElement = this.#ensureStyleElement();
    styleElement.textContent = changes.map(buildRule).join('\n');
  }

  restore(): void {
    this.#styleElement?.remove();
    this.#styleElement = null;
  }

  #ensureStyleElement(): HTMLStyleElement {
    if (this.#styleElement && this.#styleElement.isConnected) {
      return this.#styleElement;
    }

    const existing = this.#doc.getElementById(STYLE_ELEMENT_ID);
    if (existing instanceof HTMLStyleElement) {
      this.#styleElement = existing;
      return existing;
    }

    const element = this.#doc.createElement('style');
    element.id = STYLE_ELEMENT_ID;
    this.#doc.head.appendChild(element);
    this.#styleElement = element;
    return element;
  }
}
