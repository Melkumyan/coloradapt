/**
 * Native form validity changes without any attribute or DOM mutation: typing into a field
 * flips `:invalid` / `validity.valid` and nothing the MutationObserver watches. This is the one
 * event bridge M6 needs (docs/SEMANTIC_ACCESSIBILITY.md, "Native validity"). It is:
 *
 * - tiny: four passive listeners on the document, installed only while the pipeline runs;
 * - narrow: only events whose target is a form field;
 * - not an analyzer: it only names the field; the dynamic pipeline batches and decides.
 */
const FIELD = /^(?:input|select|textarea)$/;

/**
 * `input`/`change` (value edits), `focusout` (leaving a field), `invalid` (a failed submit) and
 * `reset` (a form puts every field back: validity changes with no event on the fields at all).
 */
const EVENTS = ['input', 'change', 'focusout', 'invalid', 'reset'] as const;

/** A form that is reset names its fields, up to this many. */
const MAX_RESET_FIELDS = 200;

export interface NativeValidityBridge {
  start(): void;
  stop(): void;
  readonly listening: boolean;
  /** Listeners currently installed (0 or one per event name): for leak diagnostics. */
  readonly listeners: number;
}

export function createNativeValidityBridge(
  doc: Document,
  invalidate: (field: Element) => void,
): NativeValidityBridge {
  let listening = false;
  const listener = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (FIELD.test(target.localName)) {
      invalidate(target);
    } else if (event.type === 'reset' && target.localName === 'form') {
      // The event fires before the fields change; the pipeline looks at them in its own batch, after.
      for (const field of Array.from((target as HTMLFormElement).elements).slice(
        0,
        MAX_RESET_FIELDS,
      )) {
        if (FIELD.test(field.localName)) invalidate(field);
      }
    }
  };
  return {
    get listening() {
      return listening;
    },
    get listeners() {
      return listening ? EVENTS.length : 0;
    },
    start() {
      if (listening) return;
      listening = true;
      // Capture: `invalid` and `focus*` do not bubble to the document otherwise.
      for (const name of EVENTS)
        doc.addEventListener(name, listener, { capture: true, passive: true });
    },
    stop() {
      if (!listening) return;
      listening = false;
      for (const name of EVENTS) doc.removeEventListener(name, listener, { capture: true });
    },
  };
}
