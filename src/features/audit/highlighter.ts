/** Marks ColorAdapt's own highlight overlay: ignored by every analysis and by the mutation filter. */
export const AUDIT_OVERLAY_ATTRIBUTE = 'data-coloradapt-audit-overlay';

export function isAuditOverlay(node: Node | null): boolean {
  return node instanceof Element && node.hasAttribute(AUDIT_OVERLAY_ATTRIBUTE);
}

/**
 * The element highlight of the developer audit (docs/DEVELOPER_AUDIT.md, "Highlighting"): one
 * outline drawn over one element, nothing more.
 *
 * - it is a separate, `position: fixed`, `pointer-events: none` box on the document element, so
 *   the highlighted element, its siblings and the page's layout are not touched and a click goes
 *   through it; the page's own nodes are never given a class, style or attribute;
 * - it is a double ring (light inside, dark outside) with a dashed inner line, visible on any
 *   background and not told apart by hue alone;
 * - there is at most one, and it follows the element on scroll and resize;
 * - it goes away when told to, when the element leaves the document, and when the session ends.
 */
export class AuditHighlighter {
  readonly #doc: Document;
  #box: HTMLElement | null = null;
  #target: Element | null = null;
  #frame: number | null = null;
  #resizeObserver: ResizeObserver | null = null;
  readonly #onViewportChange = (): void => this.#schedule();

  constructor(doc: Document) {
    this.#doc = doc;
  }

  get target(): Element | null {
    return this.#target;
  }

  /** Whether an overlay is in the document right now (for tests and leak checks). */
  get visible(): boolean {
    return this.#box?.isConnected === true && this.#box.style.display !== 'none';
  }

  /** Shows the outline over `element`, moving it if it was elsewhere. `scroll` brings the element into view first. */
  show(element: Element, scroll = false): boolean {
    if (!element.isConnected) {
      this.hide();
      return false;
    }
    if (scroll) element.scrollIntoView({ block: 'center', inline: 'nearest' });
    if (this.#target !== element) this.#observe(element);
    this.#target = element;
    const box = this.#ensureBox();
    this.#place(box, element);
    return true;
  }

  /** Re-reads the element's position; clears the overlay when the element is gone. */
  refresh(): void {
    const element = this.#target;
    if (!element) return;
    if (!element.isConnected) {
      this.hide();
      return;
    }
    if (this.#box) this.#place(this.#box, element);
  }

  hide(): void {
    this.#unobserve();
    this.#target = null;
    if (this.#frame !== null) {
      this.#doc.defaultView?.cancelAnimationFrame(this.#frame);
      this.#frame = null;
    }
    this.#box?.remove();
    this.#box = null;
  }

  #ensureBox(): HTMLElement {
    if (this.#box?.isConnected) return this.#box;
    const box = this.#doc.createElement('div');
    box.setAttribute(AUDIT_OVERLAY_ATTRIBUTE, '');
    box.setAttribute('aria-hidden', 'true');
    // Longhands (not shorthands): predictable everywhere, and nothing inherited from the page matters on a fixed box.
    const style = box.style;
    style.position = 'fixed';
    style.pointerEvents = 'none';
    style.zIndex = '2147483647';
    style.boxSizing = 'border-box';
    style.margin = '0';
    style.padding = '0';
    style.background = 'transparent';
    style.borderWidth = '2px';
    style.borderStyle = 'dashed';
    style.borderColor = '#ffffff';
    style.outlineWidth = '3px';
    style.outlineStyle = 'solid';
    style.outlineColor = '#111111';
    style.outlineOffset = '0';
    style.left = '0';
    style.top = '0';
    style.width = '0';
    style.height = '0';
    (this.#doc.documentElement ?? this.#doc.body).appendChild(box);
    this.#box = box;
    return box;
  }

  /**
   * A hidden element (display:none, visibility:hidden) has no rectangle: the box would sit at the
   * page's corner with nothing under it. It is not drawn until the element shows again (every page
   * mutation, scroll and resize refreshes it). Where `checkVisibility` does not exist the element is
   * taken to be visible.
   */
  #isShown(element: Element): boolean {
    const target = element as Element & { checkVisibility?: (options?: object) => boolean };
    if (typeof target.checkVisibility !== 'function') return true;
    try {
      return target.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true });
    } catch {
      return true;
    }
  }

  #place(box: HTMLElement, element: Element): void {
    if (!this.#isShown(element)) {
      box.style.display = 'none';
      return;
    }
    box.style.display = 'block';
    const rect = element.getBoundingClientRect();
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  }

  #observe(element: Element): void {
    this.#unobserve();
    const view = this.#doc.defaultView;
    view?.addEventListener('scroll', this.#onViewportChange, { capture: true, passive: true });
    view?.addEventListener('resize', this.#onViewportChange, { passive: true });
    if (view && typeof view.ResizeObserver === 'function') {
      this.#resizeObserver = new view.ResizeObserver(() => this.#schedule());
      this.#resizeObserver.observe(element);
    }
  }

  #unobserve(): void {
    const view = this.#doc.defaultView;
    view?.removeEventListener('scroll', this.#onViewportChange, { capture: true });
    view?.removeEventListener('resize', this.#onViewportChange);
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
  }

  /** One position update per frame, however many scroll events arrive. */
  #schedule(): void {
    if (this.#frame !== null) return;
    const view = this.#doc.defaultView;
    if (!view) return;
    this.#frame = view.requestAnimationFrame(() => {
      this.#frame = null;
      this.refresh();
    });
  }
}
