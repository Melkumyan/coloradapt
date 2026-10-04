/**
 * Which inline-style / class changes can alter what ColorAdapt computes.
 * ColorAdapt reads colors, backgrounds, opacity and visibility (and borders, and an
 * inline SVG's fill/stroke/mask/marker),
 * so an animation loop writing `transform` or `top` into `style` every frame
 * must not wake the analyzer.
 */

/** Longhands/shorthands whose change can alter an analysis result. */
const RELEVANT_PROPERTY =
  /^(?:color|color-scheme|opacity|visibility|display|content-visibility|filter|mix-blend-mode|all|--.*|fill|fill-opacity|stroke|stroke-opacity|stroke-width|stroke-dasharray|mask(?:-.*)?|marker(?:-.*)?|background(?:-.*)?|border(?:-(?:top|right|bottom|left))?(?:-(?:color|width|style))?|outline(?:-(?:color|width|style))?)$/;

/** Splits a declaration list on top-level `;` (not inside `()` or quotes). */
function splitDeclarations(cssText: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < cssText.length; i += 1) {
    const char = cssText[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === ';' && depth === 0) {
      parts.push(cssText.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(cssText.slice(start));
  return parts;
}

/** Fallback when no engine is at hand: raw text of each declaration. */
function parseDeclarationsRaw(cssText: string | null): Map<string, string> {
  const declarations = new Map<string, string>();
  if (!cssText) return declarations;
  for (const part of splitDeclarations(cssText)) {
    const colon = part.indexOf(':');
    if (colon <= 0) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    if (name) declarations.set(name, part.slice(colon + 1).trim());
  }
  return declarations;
}

/**
 * Declarations as the engine normalizes them (shorthands expanded, colors in
 * one notation). This matters: the first time a script touches `el.style`, the
 * browser reserializes the whole attribute (`#c0392b` becomes
 * `rgb(192, 57, 43)`), which must not look like a color change.
 */
function parseDeclarationsNormalized(
  cssText: string | null,
  probe: HTMLElement,
): Map<string, string> {
  const declarations = new Map<string, string>();
  probe.style.cssText = cssText ?? '';
  for (let i = 0; i < probe.style.length; i += 1) {
    const name = probe.style.item(i);
    declarations.set(
      name,
      `${probe.style.getPropertyValue(name)}${probe.style.getPropertyPriority(name)}`,
    );
  }
  probe.style.cssText = '';
  return declarations;
}

const probes = new WeakMap<Document, HTMLElement>();

/** A detached element used only to normalize declaration text; never inserted into the page. */
function probeFor(doc: Document): HTMLElement {
  let probe = probes.get(doc);
  if (!probe) {
    probe = doc.createElement('div');
    probes.set(doc, probe);
  }
  return probe;
}

/** True if going from `before` to `after` changes any property ColorAdapt reads. */
export function isStyleChangeRelevant(
  before: string | null,
  after: string | null,
  doc?: Document,
): boolean {
  if (before === after) return false;
  const probe = doc ? probeFor(doc) : null;
  const oldDeclarations = probe
    ? parseDeclarationsNormalized(before, probe)
    : parseDeclarationsRaw(before);
  const newDeclarations = probe
    ? parseDeclarationsNormalized(after, probe)
    : parseDeclarationsRaw(after);
  for (const name of new Set([...oldDeclarations.keys(), ...newDeclarations.keys()])) {
    if (oldDeclarations.get(name) === newDeclarations.get(name)) continue;
    if (RELEVANT_PROPERTY.test(name)) return true;
  }
  return false;
}

/** True unless the class list only changed order/whitespace. */
export function isClassChangeRelevant(before: string | null, after: string | null): boolean {
  if (before === after) return false;
  const tokens = (value: string | null) => new Set((value ?? '').split(/\s+/).filter(Boolean));
  const oldTokens = tokens(before);
  const newTokens = tokens(after);
  if (oldTokens.size !== newTokens.size) return true;
  for (const token of oldTokens) if (!newTokens.has(token)) return true;
  return false;
}
