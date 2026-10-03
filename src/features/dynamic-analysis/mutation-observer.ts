import { OBSERVED_ATTRIBUTES } from './mutation-classifier';

export type ObserverFactory = (callback: MutationCallback) => MutationObserver;

/**
 * The single MutationObserver of a document. One instance, connected on
 * `start()` and disconnected on `stop()`; `start()` while connected is a
 * no-op, so repeated ON/OFF/ON can never stack subscriptions.
 *
 * Subscriptions (kept deliberately narrow, docs/DYNAMIC_ANALYSIS.md):
 * - the document subtree: child lists, the attributes in
 *   {@link OBSERVED_ATTRIBUTES}, and character data (the classifier keeps only
 *   the empty/non-empty text transitions that change eligibility);
 * - `<html>` and `<body>` themselves, for every attribute, so a theme switch
 *   such as `data-theme="dark"` is seen without opening up all `data-*`.
 */
export class DocumentMutationObserver {
  readonly #doc: Document;
  readonly #observer: MutationObserver;
  #connected = false;
  #observedBody: HTMLElement | null = null;
  #starts = 0;

  constructor(
    doc: Document,
    onRecords: (records: MutationRecord[]) => void,
    createObserver: ObserverFactory = (callback) => new MutationObserver(callback),
  ) {
    this.#doc = doc;
    this.#observer = createObserver((records) => onRecords(records));
  }

  get connected(): boolean {
    return this.#connected;
  }

  /** How many times the observer was actually connected. */
  get starts(): number {
    return this.#starts;
  }

  start(): void {
    if (this.#connected) return;
    this.#connected = true;
    this.#starts += 1;
    this.#observer.observe(this.#doc, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [...OBSERVED_ATTRIBUTES],
      attributeOldValue: true,
      characterData: true,
      characterDataOldValue: true,
    });
    this.#observeRoots();
  }

  /** Re-subscribes the root elements if `<body>` was replaced. Cheap; call after each flush. */
  syncRoots(): void {
    if (this.#connected && this.#doc.body !== this.#observedBody) this.#observeRoots();
  }

  /** Disconnects and discards anything not yet delivered. */
  stop(): void {
    if (!this.#connected) return;
    this.#connected = false;
    this.#observer.disconnect();
    this.#observedBody = null;
  }

  /** Records queued in the browser but not yet delivered. */
  takeRecords(): MutationRecord[] {
    return this.#connected ? this.#observer.takeRecords() : [];
  }

  #observeRoots(): void {
    const options = { attributes: true, attributeOldValue: true };
    this.#observer.observe(this.#doc.documentElement, options);
    this.#observedBody = this.#doc.body;
    if (this.#observedBody) this.#observer.observe(this.#observedBody, options);
  }
}
