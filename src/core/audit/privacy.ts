import type { AuditPageInfo } from './types';
import { LOCATOR_LIMITS } from './types';

/**
 * The privacy contract of the audit (docs/PRIVACY.md, "Developer audit"). The audit is not a DOM
 * dump: a report may hold only what a developer needs to find an element, and each thing it may
 * hold passes through one of these functions.
 *
 * - page text: a short, whitespace-collapsed snippet with obvious personal data replaced;
 * - names (ids, classes, roles, input types): a short snippet of safe characters, or nothing;
 * - the page address: origin and a path with opaque segments redacted (no credentials, query, hash);
 * - never: values of form controls, cookies, storage, headers, full HTML, `data-*` attributes.
 */

/** FNV-1a, two independent 32-bit lanes: 16 hex characters. Deterministic, not cryptographic. */
export function stableHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ (code + i), 0x85ebca6b) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const LONG_NUMBER = /\d[\d\s().+-]{5,}\d/g;
const OPAQUE_TOKEN = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g;
const HEX_TOKEN = /\b[0-9a-fA-F]{16,}\b/g;

/** Collapses whitespace, replaces obvious personal data and opaque tokens, and cuts to `max`. */
export function redactSnippet(
  text: string,
  max: number = LOCATOR_LIMITS.textLength,
): string | null {
  // Only a bounded window is ever looked at: the patterns below would be quadratic on 100 KB of
  // text without spaces, and nothing past the window can reach the first `max` characters of the result.
  const window = text.length > READ_WINDOW ? text.slice(0, READ_WINDOW) : text;
  const collapsed = stripUnsafeCharacters(window)
    .replace(EMAIL, '[email]')
    .replace(OPAQUE_TOKEN, '[token]')
    .replace(HEX_TOKEN, '[token]')
    .replace(LONG_NUMBER, '[number]')
    // Control characters have no place in a report.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed === '') return null;
  if (collapsed.length <= max) return collapsed;
  let end = max - 1;
  // Never cut a surrogate pair in half.
  if (/[\uD800-\uDBFF]/.test(collapsed.charAt(end - 1))) end -= 1;
  return `${collapsed.slice(0, end)}…`;
}

const READ_WINDOW = 2000;

/**
 * Characters that can change how a report reads or renders without being visible: bidirectional
 * overrides and isolates, zero-width and other format characters, line/paragraph separators,
 * controls and unpaired surrogates. Visible emoji, combining marks and any script are kept.
 */
const INVISIBLE_OR_UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function stripUnsafeCharacters(text: string): string {
  return text.replace(UNPAIRED_SURROGATE, '').replace(INVISIBLE_OR_UNSAFE, ' ');
}

/** True when a string holds a character {@link stripUnsafeCharacters} would remove. */
export function hasUnsafeCharacters(text: string): boolean {
  return (
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text) || new RegExp(UNPAIRED_SURROGATE.source).test(text)
  );
}

const SAFE_NAME = /^[A-Za-z0-9_\-:.]+$/;

/**
 * A class name, id or other author-chosen name, kept only if it is short and made of ordinary
 * characters. A name that looks like an identifier or a secret (`user-4821907`, a 24-character
 * hash) is replaced rather than copied.
 */
export function safeName(name: string | null | undefined): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (trimmed === '' || !SAFE_NAME.test(trimmed)) return null;
  const cut =
    trimmed.length > LOCATOR_LIMITS.tokenLength
      ? trimmed.slice(0, LOCATOR_LIMITS.tokenLength)
      : trimmed;
  if (/\d{6,}/.test(cut) || /[0-9a-f]{16,}/i.test(cut)) return '[redacted]';
  if (cut.length >= 20 && /\d/.test(cut) && /[A-Za-z]/.test(cut) && !/[-_]/.test(cut))
    return '[redacted]';
  return cut;
}

/** Class names that describe a component (not a generated hash or a per-row number). */
export function componentClassNames(classes: readonly string[], limit: number): string[] {
  const kept: string[] = [];
  for (const name of classes) {
    const safe = safeName(name);
    if (!safe || safe === '[redacted]') continue;
    // Per-row numbers (`row-17`), generated hashes (`css-1x2y3z4`) and long names are not what a component is called.
    if (/\d{2,}/.test(safe) || (safe.match(/\d/g)?.length ?? 0) >= 3 || safe.length > 24) continue;
    kept.push(safe);
    if (kept.length >= limit) break;
  }
  return kept;
}

/** Path segments that look like an opaque identifier or token are replaced. */
function redactPathSegment(segment: string): string {
  const bare = segment.split(';')[0] ?? '';
  if (bare === '') return bare;
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    // Keep the raw segment; it is judged below as is.
  }
  const opaque =
    /^[0-9a-f]{16,}$/i.test(decoded) ||
    /^\d{6,}$/.test(decoded) ||
    (decoded.length >= 20 &&
      /\d/.test(decoded) &&
      /[A-Za-z]/.test(decoded) &&
      /^[A-Za-z0-9_-]+$/.test(decoded)) ||
    /@/.test(decoded);
  if (opaque) return ':redacted';
  return /^[A-Za-z0-9._~%!$&'()*+,=:@-]*$/.test(bare) ? bare : ':redacted';
}

/**
 * The only part of the page address a report keeps: `origin` and a pathname with opaque segments
 * (`/reset/9f8a…`) redacted. Credentials, port-less quirks, the query and the fragment never get here.
 */
export function sanitizePageUrl(url: string): AuditPageInfo {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { origin: 'null', pathname: '/' };
    }
    const pathname = parsed.pathname.split('/').map(redactPathSegment).join('/');
    return { origin: parsed.origin, pathname: pathname === '' ? '/' : pathname };
  } catch {
    return { origin: 'null', pathname: '/' };
  }
}

/**
 * Whether `rawUrl` is still the page a snapshot describes. Only the sanitized origin and path are
 * compared, so a query or fragment change (which a report never holds) is not a route change, and
 * the raw address is neither stored nor returned.
 */
export function describesSamePage(page: AuditPageInfo, rawUrl: string): boolean {
  const now = sanitizePageUrl(rawUrl);
  return now.origin === page.origin && now.pathname === page.pathname;
}

/** `coloradapt-audit-<host>-<yyyy-mm-dd>.<ext>`: letters, digits, dots and dashes only. */
export function auditFileName(
  page: AuditPageInfo,
  isoDate: string,
  extension: 'json' | 'html',
): string {
  let host = 'page';
  try {
    host = new URL(page.origin).hostname;
  } catch {
    // `null` origin: keep the generic name.
  }
  const safeHost = host
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  const date = /^\d{4}-\d{2}-\d{2}/.exec(isoDate)?.[0] ?? '0000-00-00';
  return `coloradapt-audit-${safeHost === '' ? 'page' : safeHost}-${date}.${extension}`;
}

/** Escapes text for an HTML text node or a double-quoted attribute value. */
export function escapeHtml(text: string): string {
  return stripUnsafeCharacters(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
