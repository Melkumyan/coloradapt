/**
 * Identity of the document a measurement runs against. A page that replaces itself (a bot check that reloads
 * into the real page, a consent redirect, a meta refresh) must never have one audit read from the old
 * document and the oracle from the new one, or the comparison would blame the product for a race of the
 * harness. `performance.timeOrigin` is new for every document a navigation creates; the address changes on a
 * same-document route change.
 */
export const DOCUMENT_IDENTITY_SOURCE = `(performance.timeOrigin + '|' + location.href + '|' + document.readyState)`;

export interface DocumentIdentity {
  readonly timeOrigin: string;
  readonly href: string;
}

export function parseDocumentIdentity(raw: string): DocumentIdentity {
  const [timeOrigin = '', href = ''] = raw.split('|');
  return { timeOrigin, href };
}

/** The same document and address, not merely the same `readyState`. */
export function sameDocument(a: DocumentIdentity, b: DocumentIdentity): boolean {
  return a.timeOrigin === b.timeOrigin && a.href === b.href;
}

/** Runs `measure`; its result is kept only when the document is the one `expected` names, before and after. */
export async function onlyForDocument<T>(
  read: () => Promise<DocumentIdentity>,
  expected: DocumentIdentity,
  measure: () => Promise<T>,
): Promise<{ stale: false; value: T } | { stale: true }> {
  if (!sameDocument(await read(), expected)) return { stale: true };
  const value = await measure();
  return sameDocument(await read(), expected) ? { stale: false, value } : { stale: true };
}
