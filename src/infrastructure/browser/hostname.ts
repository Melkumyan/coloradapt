/** Extracts a normalized hostname from a page URL, or `null` for non-http(s) pages. */
export function getHostname(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname;
  } catch {
    return null;
  }
}
