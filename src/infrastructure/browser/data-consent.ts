import { browser } from 'wxt/browser';

/**
 * Firefox's built-in data-collection consent (docs/AI_PRIVACY.md, "Firefox consent"; docs/store/STORE_RELEASE.md).
 *
 * The Firefox build declares `websiteContent` as an OPTIONAL data-collection permission, because the optional
 * AI-assisted review may send sanitized, page-derived semantic context to the loopback model runtime, and
 * Firefox counts that as data leaving the add-on. The permission is requested only from the click on "Run
 * AI-assisted review" (never on install, startup or page load), and nothing is sent without it. The Chrome
 * build has no such manifest key, so for it consent is not applicable.
 *
 * Whether consent applies is read from the packaged manifest, not guessed from the user agent.
 */

const WEBSITE_CONTENT = 'websiteContent';

export type ConsentResult = 'not-required' | 'granted' | 'denied';

interface DataCollectionPermissions {
  readonly data_collection?: readonly string[];
}

interface ConsentApi {
  getAll(): Promise<DataCollectionPermissions>;
  request(permissions: { data_collection: string[] }): Promise<boolean>;
  onRemoved?: {
    addListener(listener: (permissions: DataCollectionPermissions) => void): void;
    removeListener(listener: (permissions: DataCollectionPermissions) => void): void;
  };
}

interface ManifestWithDataCollection {
  readonly browser_specific_settings?: {
    readonly gecko?: {
      readonly data_collection_permissions?: { readonly optional?: readonly string[] };
    };
  };
}

const api = (): ConsentApi => browser.permissions as unknown as ConsentApi;

/** Whether this build asks the browser for consent before page-derived context may leave the add-on. */
export function consentRequired(): boolean {
  const manifest = browser.runtime.getManifest() as ManifestWithDataCollection;
  return (
    manifest.browser_specific_settings?.gecko?.data_collection_permissions?.optional?.includes(
      WEBSITE_CONTENT,
    ) === true
  );
}

/** Whether sending is allowed right now: always where consent does not apply, else only while granted. */
export async function websiteContentAllowed(): Promise<boolean> {
  if (!consentRequired()) return true;
  try {
    const granted = (await api().getAll()).data_collection;
    return Array.isArray(granted) && granted.includes(WEBSITE_CONTENT);
  } catch {
    return false;
  }
}

/**
 * Asks for consent. Call it first thing in the click handler, before any other await: Firefox only accepts the
 * request from a user action. Asking when it is granted already resolves true without a prompt. A browser that
 * does not know data-collection permissions (an older Firefox) rejects the request: that is `denied`, and
 * nothing is ever sent (the packaged `strict_min_version` keeps such a browser from installing it anyway).
 */
export async function requestWebsiteContentConsent(): Promise<ConsentResult> {
  if (!consentRequired()) return 'not-required';
  try {
    return (await api().request({ data_collection: [WEBSITE_CONTENT] })) ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

/** Calls `onRevoked` when `websiteContent` is removed (about:addons). Returns the unsubscribe. */
export function watchWebsiteContentRevoked(onRevoked: () => void): () => void {
  if (!consentRequired()) return () => undefined;
  const events = api().onRemoved;
  if (!events) return () => undefined;
  const listener = (removed: DataCollectionPermissions): void => {
    if (removed.data_collection?.includes(WEBSITE_CONTENT)) onRevoked();
  };
  events.addListener(listener);
  return () => events.removeListener(listener);
}
