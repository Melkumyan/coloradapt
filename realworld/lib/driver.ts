/**
 * One small interface over two real browsers, so the same real-world scenarios run unchanged in both:
 *
 * - **Chrome**: the installed, branded Chrome is spawned headless with `--enable-unsafe-extension-debugging`,
 *   the production build (`dist/chrome-mv3`) is loaded with the DevTools command `Extensions.loadUnpacked`
 *   (branded Chrome ignores `--load-extension`), and Playwright only attaches over CDP to drive pages.
 * - **Firefox**: the installed Firefox is started by `geckodriver`, and the production build
 *   (`dist/firefox-mv2`) is installed as a temporary add-on through WebDriver. The extension's pages are
 *   reachable because the add-on id has a fixed `moz-extension://` UUID preference.
 *
 * Extension-side calls (settings, `tabs.sendMessage`) run inside an extension page of the browser under
 * test, with the extension's own `chrome`/`browser` API: nothing is mocked and no test hook is built in.
 */
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from '@playwright/test';
import { normalizeErrorSource, toError, type NormalizedError } from './errors';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const SETTINGS_KEY = 'coloradapt:settings';
export const FIREFOX_ID = 'coloradapt@coloradapt.invalid';
export const FIREFOX_UUID = '5d1c9a3e-7b2f-4c11-9a55-0d6f3e8b1a42';

export type BrowserName = 'chrome' | 'firefox';

export interface OpenResult {
  readonly loaded: boolean;
  readonly error: string | null;
  readonly url: string;
}

export interface LogEntry {
  readonly level: string;
  readonly text: string;
  /** Where it came from, when the browser says (an isolated world name, a realm, a URL). */
  readonly source: string;
}

export interface Tab {
  open(url: string): Promise<OpenResult>;
  /**
   * Evaluates one *expression* (a statement list is not valid: Firefox wraps the source in parentheses) in the page's
   * own world; use `(async () => ...)()` for async work. The result must be JSON-serializable.
   */
  evaluate<T>(source: string): Promise<T>;
  /** Sends a typed ColorAdapt message to this tab's content script, from the extension's own page. */
  ext<T>(type: string, payload?: unknown): Promise<T>;
  screenshot(): Promise<Buffer>;
  /** Console errors and warnings and uncaught exceptions since the last call. */
  drainLogs(): LogEntry[];
  url(): Promise<string>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  /** Brings this tab to the front (a tab switch). */
  focus(): Promise<void>;
  /** A real click on the first element matching a CSS selector. */
  click(selector: string): Promise<void>;
  /** A real click on the button whose accessible name is `name` (a genuine user gesture, unlike `element.click()`). */
  clickButton(name: string): Promise<void>;
  /** A real key press: `Tab`, `Shift+Tab`, `Enter`, `Space`, `Escape`, `ArrowDown`, `ArrowUp`, `ArrowLeft`, `ArrowRight`. */
  press(key: string): Promise<void>;
  /** Clicks the element matching the selector, then types the text with real keystrokes. */
  type(selector: string, text: string): Promise<void>;
  close(): Promise<void>;
}

export interface Driver {
  readonly name: BrowserName;
  readonly version: string;
  readonly extensionOrigin: string;
  newTab(): Promise<Tab>;
  /** A tab showing one of the extension's own pages (`popup.html`, `audit.html?...`). */
  extensionTab(pagePath: string): Promise<Tab>;
  setSettings(settings: Record<string, unknown>): Promise<void>;
  getSettings(): Promise<unknown>;
  /** Runs `source` in an extension page (the helper tab), with `api` = `browser ?? chrome`. */
  extensionEval<T>(source: string): Promise<T>;
  /** Reloads the extension the way the browser's own reload does (settings are kept). */
  reloadExtension(): Promise<void>;
  close(): Promise<void>;
}

const VIEWPORT = { width: 1280, height: 900 };

function killTree(proc: ChildProcess | null): void {
  if (!proc?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
  else proc.kill('SIGKILL');
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function removeDir(dir: string): void {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // the browser may still hold a handle for a moment
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},400)']);
    }
  }
}

function chromeBinary(): string {
  const candidates = [
    process.env['CHROME_BIN'],
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const found = candidates.find((c) => c && existsSync(c));
  if (!found) throw new Error('Chrome not found: set CHROME_BIN');
  return found;
}

function firefoxBinary(): string {
  const candidates = [
    process.env['FIREFOX_BIN'],
    'C:/Program Files/Mozilla Firefox/firefox.exe',
    'C:/Program Files (x86)/Mozilla Firefox/firefox.exe',
    '/usr/bin/firefox',
    '/Applications/Firefox.app/Contents/MacOS/firefox',
  ];
  const found = candidates.find((c) => c && existsSync(c));
  if (!found) throw new Error('Firefox not found: set FIREFOX_BIN');
  return found;
}

function geckodriverBinary(): string {
  const candidates = [
    process.env['GECKODRIVER'],
    path.join(ROOT, 'realworld', '.tools', 'geckodriver.exe'),
    path.join(ROOT, 'realworld', '.tools', 'geckodriver'),
  ];
  const found = candidates.find((c) => c && existsSync(c));
  if (!found)
    throw new Error('geckodriver not found: run `node realworld/tools/fetch-geckodriver.mjs`');
  return found;
}

// ---------------------------------------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------------------------------------

export interface ChromeOptions {
  /** `false` starts Chrome without the extension (the "extension OFF" performance baseline). */
  readonly extension?: boolean;
  /** Reuse a profile directory (browser restart scenarios); a fresh one is made otherwise. */
  readonly profileDir?: string;
  /** Keep a profile this driver created when it closes (so a second driver can reopen it). */
  readonly keepProfile?: boolean;
  readonly port?: number;
  readonly extensionDir?: string;
}

export class ChromeTab implements Tab {
  readonly #logs: LogEntry[] = [];
  #metricsSession: CDPSession | null = null;
  readonly #driver: ChromeDriver;
  readonly page: Page;
  readonly #contexts = new Map<number, string>();

  constructor(driver: ChromeDriver, page: Page) {
    this.#driver = driver;
    this.page = page;
  }

  async attach(): Promise<void> {
    this.page.on('pageerror', (e) =>
      this.#logs.push({
        level: 'pageerror',
        text: String(e.message).slice(0, 300),
        source: 'page',
      }),
    );
    try {
      const cdp: CDPSession = await this.page.context().newCDPSession(this.page);
      cdp.on('Runtime.executionContextCreated', (e) => {
        const ctx = e.context as { id: number; name?: string; origin?: string };
        this.#contexts.set(ctx.id, `${ctx.name ?? ''}@${ctx.origin ?? ''}`);
      });
      cdp.on('Runtime.consoleAPICalled', (e) => {
        const type = String(e.type);
        if (type !== 'error' && type !== 'warning' && type !== 'assert') return;
        const text = (
          e.args as Array<{ value?: string | number | boolean | null; description?: string }>
        )
          .map((a) => String(a.value ?? a.description ?? ''))
          .join(' ')
          .slice(0, 300);
        this.#logs.push({
          level: type,
          text,
          source: this.#contexts.get(e.executionContextId) ?? 'unknown',
        });
      });
      cdp.on('Runtime.exceptionThrown', (e) => {
        const d = e.exceptionDetails as {
          text?: string;
          exception?: { description?: string };
          executionContextId?: number;
          url?: string;
        };
        this.#logs.push({
          level: 'exception',
          text: String(d.exception?.description ?? d.text ?? '').slice(0, 300),
          source:
            `${this.#contexts.get(d.executionContextId ?? -1) ?? 'unknown'} ${d.url ?? ''}`.trim(),
        });
      });
      await cdp.send('Runtime.enable');
    } catch {
      // logging is best effort
    }
  }

  /** Names and origins of the JavaScript worlds the page has had (the extension's isolated world among them). */
  knownContexts(): string[] {
    return [...this.#contexts.values()];
  }

  /** A DevTools session on this tab (metrics, heap, DOM counters): Chrome only. */
  async session(): Promise<CDPSession> {
    this.#metricsSession ??= await this.page.context().newCDPSession(this.page);
    return this.#metricsSession;
  }

  async open(url: string): Promise<OpenResult> {
    let error: string | null = null;
    try {
      await this.page.goto(url, { waitUntil: 'load', timeout: 45_000 });
    } catch (e) {
      error = (e as Error).message.split('\n')[0] ?? 'navigation failed';
    }
    return { loaded: error === null, error, url: this.page.url() };
  }

  async evaluate<T>(source: string): Promise<T> {
    return await this.page.evaluate(source);
  }

  ext<T>(type: string, payload?: unknown): Promise<T> {
    return this.#driver.extensionEval<T>(sendScript(this.page.url(), type, payload));
  }

  async screenshot(): Promise<Buffer> {
    return this.page.screenshot({ type: 'png', animations: 'disabled', timeout: 30_000 });
  }

  drainLogs(): LogEntry[] {
    return this.#logs.splice(0);
  }

  url(): Promise<string> {
    return Promise.resolve(this.page.url());
  }

  async back(): Promise<void> {
    await this.page.goBack({ waitUntil: 'commit', timeout: 15_000 }).catch(() => null);
  }

  async forward(): Promise<void> {
    await this.page.goForward({ waitUntil: 'commit', timeout: 15_000 }).catch(() => null);
  }

  async reload(): Promise<void> {
    await this.page.reload({ waitUntil: 'load', timeout: 45_000 }).catch(() => null);
  }

  async focus(): Promise<void> {
    await this.page.bringToFront();
  }

  async click(selector: string): Promise<void> {
    await this.page.click(selector, { timeout: 10_000 });
  }

  async clickButton(name: string): Promise<void> {
    await this.page.getByRole('button', { name, exact: true }).click({ timeout: 10_000 });
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key === 'Space' ? ' ' : key);
  }

  async type(selector: string, text: string): Promise<void> {
    await this.page.click(selector, { timeout: 10_000 });
    await this.page.keyboard.type(text);
  }

  async close(): Promise<void> {
    await this.page.close({ runBeforeUnload: false }).catch(() => null);
  }
}

/** The script an extension page runs to deliver one typed message to the tab showing `url`. */
function sendScript(url: string, type: string, payload: unknown): string {
  return `(async () => {
    const api = globalThis.browser ?? globalThis.chrome;
    const tabs = (await api.tabs.query({})).filter((t) => t.url === ${JSON.stringify(url)});
    if (tabs.length !== 1) throw new Error('expected one tab for the page, found ' + tabs.length);
    const payload = ${payload === undefined ? 'undefined' : JSON.stringify(payload)};
    return await api.tabs.sendMessage(tabs[0].id, { channel: 'coloradapt', type: ${JSON.stringify(type)}, payload });
  })()`;
}

export class ChromeDriver implements Driver {
  readonly name = 'chrome' as const;
  version = '';
  extensionOrigin = '';
  #proc: ChildProcess | null = null;
  #browser: Browser | null = null;
  #context: BrowserContext | null = null;
  #profile = '';
  #helper: Page | null = null;
  #extId = '';
  readonly #opts: ChromeOptions;
  #ownsProfile = true;

  constructor(opts: ChromeOptions = {}) {
    this.#opts = opts;
  }

  get profileDir(): string {
    return this.#profile;
  }

  /** The id Chrome gave the unpacked extension. */
  get extensionId(): string {
    return this.#extId;
  }

  get browserContext(): BrowserContext {
    if (!this.#context) throw new Error('not started');
    return this.#context;
  }

  /** The browser-level CDP session (extension management, tracing). */
  newBrowserSession(): Promise<CDPSession> {
    if (!this.#browser) throw new Error('not started');
    return this.#browser.newBrowserCDPSession();
  }

  async start(): Promise<this> {
    const port = this.#opts.port ?? 9333 + Math.floor(Math.random() * 500);
    this.#ownsProfile = this.#opts.profileDir === undefined && this.#opts.keepProfile !== true;
    this.#profile = this.#opts.profileDir ?? mkdtempSync(path.join(tmpdir(), 'coloradapt-chrome-'));
    this.#proc = spawn(
      chromeBinary(),
      [
        `--remote-debugging-port=${port}`,
        '--enable-unsafe-extension-debugging',
        `--user-data-dir=${this.#profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--headless=new',
        '--disable-search-engine-choice-screen',
        `--window-size=${VIEWPORT.width},${VIEWPORT.height + 120}`,
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    for (let i = 0; i < 60 && !this.#browser; i++) {
      await sleep(500);
      try {
        this.#browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      } catch {
        // not up yet
      }
    }
    if (!this.#browser) throw new Error('Chrome did not start');
    this.version = this.#browser.version();
    this.#context = this.#browser.contexts()[0] ?? null;
    if (!this.#context) throw new Error('no default browser context');
    if (this.#opts.extension !== false) {
      const cdp = await this.#browser.newBrowserCDPSession();
      const dir = (
        this.#opts.extensionDir ??
        process.env['RW_CHROME_EXT'] ??
        path.join(ROOT, 'dist', 'chrome-mv3')
      ).replace(/\\/g, '/');
      const loaded = (await cdp.send(
        'Extensions.loadUnpacked' as never,
        { path: dir } as never,
      )) as {
        id: string;
      };
      this.#extId = loaded.id;
      this.extensionOrigin = `chrome-extension://${this.#extId}`;
      this.#helper = await this.#context.newPage();
      await this.#helper.goto(`${this.extensionOrigin}/popup.html`);
    }
    return this;
  }

  async newTab(): Promise<Tab> {
    const context = this.#context;
    if (!context) throw new Error('not started');
    const page = await context.newPage();
    await page.setViewportSize(VIEWPORT);
    const tab = new ChromeTab(this, page);
    await tab.attach();
    return tab;
  }

  async extensionTab(pagePath: string): Promise<Tab> {
    const tab = (await this.newTab()) as ChromeTab;
    await tab.open(`${this.extensionOrigin}/${pagePath}`);
    return tab;
  }

  async extensionEval<T>(source: string): Promise<T> {
    if (!this.#helper) throw new Error('no extension loaded');
    return await this.#helper.evaluate(source);
  }

  async setSettings(settings: Record<string, unknown>): Promise<void> {
    await this.extensionEval(
      `(async () => { const api = globalThis.browser ?? globalThis.chrome; await api.storage.local.set({ ${JSON.stringify(SETTINGS_KEY)}: ${JSON.stringify(settings)} }); })()`,
    );
  }

  getSettings(): Promise<unknown> {
    return this.extensionEval(
      `(async () => { const api = globalThis.browser ?? globalThis.chrome; return (await api.storage.local.get(${JSON.stringify(SETTINGS_KEY)}))[${JSON.stringify(SETTINGS_KEY)}]; })()`,
    );
  }

  /**
   * What the "reload" button of chrome://extensions does for an unpacked extension: unload it and load the same
   * folder again (same id). `runtime.reload()` cannot be used: an extension loaded over DevTools is not persisted.
   */
  async reloadExtension(): Promise<void> {
    if (!this.#helper || !this.#browser) throw new Error('no extension loaded');
    const session = await this.#browser.newBrowserCDPSession();
    // An uninstall wipes the extension's storage, a real reload does not: carry `storage.local` across.
    const saved = await this.#helper.evaluate<Record<string, unknown>>(
      'chrome.storage.local.get(null)',
    );
    await this.#helper.close().catch(() => null);
    await session.send('Extensions.uninstall' as never, { id: this.#extId } as never);
    const dir = (this.#opts.extensionDir ?? path.join(ROOT, 'dist', 'chrome-mv3')).replace(
      /\\/g,
      '/',
    );
    const loaded = (await session.send(
      'Extensions.loadUnpacked' as never,
      { path: dir } as never,
    )) as {
      id: string;
    };
    if (loaded.id !== this.#extId) throw new Error(`extension id changed on reload: ${loaded.id}`);
    this.#helper = await this.#context!.newPage();
    await this.#helper.goto(`${this.extensionOrigin}/popup.html`);
    await this.#helper.evaluate(`chrome.storage.local.set(${JSON.stringify(saved)})`);
  }

  async close(): Promise<void> {
    await this.#browser?.close().catch(() => null);
    killTree(this.#proc);
    await sleep(500);
    if (this.#ownsProfile) removeDir(this.#profile);
  }
}

export async function startChrome(opts: ChromeOptions = {}): Promise<ChromeDriver> {
  return new ChromeDriver(opts).start();
}

// ---------------------------------------------------------------------------------------------------------
// Firefox
// ---------------------------------------------------------------------------------------------------------

export interface FirefoxOptions {
  readonly extension?: boolean;
  readonly port?: number;
  readonly extensionDir?: string;
  /** Extra preferences. */
  readonly prefs?: Record<string, unknown>;
  /** Use (and keep) this profile directory: browser restart scenarios. */
  readonly profileDir?: string;
}

type BidiPending = Map<number, (value: { error?: string; result?: unknown }) => void>;

class FirefoxTab implements Tab {
  readonly #driver: FirefoxDriver;
  readonly handle: string;

  constructor(driver: FirefoxDriver, handle: string) {
    this.#driver = driver;
    this.handle = handle;
  }

  async #select(): Promise<void> {
    await this.#driver.select(this.handle);
  }

  async open(url: string): Promise<OpenResult> {
    await this.#select();
    let error: string | null = null;
    try {
      await this.#driver.wd('POST', '/url', { url });
    } catch (e) {
      error = (e as Error).message.split('\n')[0] ?? 'navigation failed';
    }
    let finalUrl = url;
    try {
      finalUrl = (await this.#driver.wd('GET', '/url')) as string;
    } catch {
      // keep the requested one
    }
    return { loaded: error === null, error, url: finalUrl };
  }

  async evaluate<T>(source: string): Promise<T> {
    await this.#select();
    return this.#driver.run<T>(source);
  }

  async ext<T>(type: string, payload?: unknown): Promise<T> {
    const url = await this.url();
    return this.#driver.extensionEval<T>(sendScript(url, type, payload));
  }

  async screenshot(): Promise<Buffer> {
    await this.#select();
    const b64 = (await this.#driver.wd('GET', '/screenshot')) as string;
    return Buffer.from(b64, 'base64');
  }

  drainLogs(): LogEntry[] {
    return this.#driver.drainLogs(this.handle);
  }

  async url(): Promise<string> {
    await this.#select();
    return (await this.#driver.wd('GET', '/url')) as string;
  }

  async back(): Promise<void> {
    await this.#select();
    await this.#driver.wd('POST', '/back', {}).catch(() => null);
  }

  async forward(): Promise<void> {
    await this.#select();
    await this.#driver.wd('POST', '/forward', {}).catch(() => null);
  }

  async reload(): Promise<void> {
    await this.#select();
    await this.#driver.wd('POST', '/refresh', {}).catch(() => null);
  }

  async focus(): Promise<void> {
    await this.#select();
  }

  async click(selector: string): Promise<void> {
    await this.#select();
    const el = (await this.#driver.wd('POST', '/element', {
      using: 'css selector',
      value: selector,
    })) as Record<string, string>;
    const id = Object.values(el)[0]!;
    await this.#driver.wd('POST', `/element/${id}/click`, {});
  }

  async clickButton(name: string): Promise<void> {
    await this.#select();
    const literal = name.includes("'")
      ? `concat('${name.split("'").join("',\"'\",'")}')`
      : `'${name}'`;
    const el = (await this.#driver.wd('POST', '/element', {
      using: 'xpath',
      value: `//button[normalize-space(.)=${literal}]`,
    })) as Record<string, string>;
    await this.#driver.wd('POST', `/element/${Object.values(el)[0]!}/click`, {});
  }

  async press(key: string): Promise<void> {
    await this.#select();
    const CODES: Record<string, string> = {
      Tab: '\uE004',
      Enter: '\uE007',
      Space: ' ',
      Escape: '\uE00C',
      ArrowLeft: '\uE012',
      ArrowUp: '\uE013',
      ArrowRight: '\uE014',
      ArrowDown: '\uE015',
      Shift: '\uE008',
    };
    const parts = key.split('+').map((k) => CODES[k] ?? k);
    const actions = [
      ...parts.map((value) => ({ type: 'keyDown', value })),
      ...[...parts].reverse().map((value) => ({ type: 'keyUp', value })),
    ];
    await this.#driver.wd('POST', '/actions', {
      actions: [{ type: 'key', id: 'keyboard', actions }],
    });
    await this.#driver.wd('DELETE', '/actions');
  }

  async type(selector: string, text: string): Promise<void> {
    await this.click(selector);
    await this.#driver.wd('POST', '/actions', {
      actions: [
        {
          type: 'key',
          id: 'keyboard',
          actions: [...text].flatMap((value) => [
            { type: 'keyDown', value },
            { type: 'keyUp', value },
          ]),
        },
      ],
    });
    await this.#driver.wd('DELETE', '/actions');
  }

  async close(): Promise<void> {
    await this.#select();
    await this.#driver.wd('DELETE', '/window').catch(() => null);
    this.#driver.forget(this.handle);
  }
}

export class FirefoxDriver implements Driver {
  readonly name = 'firefox' as const;
  version = '';
  readonly extensionOrigin = `moz-extension://${FIREFOX_UUID}`;
  #proc: ChildProcess | null = null;
  #sid = '';
  #base = '';
  #helper: string | null = null;
  #current = '';
  #ws: WebSocket | null = null;
  #bidiId = 0;
  readonly #pending: BidiPending = new Map();
  readonly #logs = new Map<string, LogEntry[]>();
  readonly #opts: FirefoxOptions;

  constructor(opts: FirefoxOptions = {}) {
    this.#opts = opts;
  }

  async wd(method: string, route: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.#base}/session/${this.#sid}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as { value?: unknown };
    const v = json.value as { error?: string; message?: string } | undefined;
    if (v && typeof v === 'object' && 'error' in v && v.error) {
      throw new Error(`${route}: ${v.error}: ${v.message ?? ''}`);
    }
    return json.value;
  }

  async select(handle: string): Promise<void> {
    if (this.#current === handle) return;
    await this.wd('POST', '/window', { handle });
    this.#current = handle;
  }

  forget(handle: string): void {
    this.#logs.delete(handle);
    if (this.#current === handle) this.#current = '';
  }

  /** Runs a script source in the selected tab's page world and returns its (awaited) result. */
  async run<T>(source: string): Promise<T> {
    const result = (await this.wd('POST', '/execute/async', {
      script: `const done = arguments[arguments.length - 1];
        const normalize = ${normalizeErrorSource};
        Promise.resolve().then(() => (${source})).then((v) => done({ ok: v === undefined ? null : v }), (e) => done({ err: normalize(e) }));`,
      args: [],
    })) as { ok?: T; err?: NormalizedError };
    if (result.err !== undefined) throw toError(result.err);
    return result.ok as T;
  }

  drainLogs(handle: string): LogEntry[] {
    return (this.#logs.get(handle) ?? []).splice(0);
  }

  /** Console errors/warnings of every tab since the last call. */
  allLogs(): LogEntry[] {
    return (this.#logs.get('*') ?? []).splice(0);
  }

  async start(): Promise<this> {
    const port = this.#opts.port ?? 4500 + Math.floor(Math.random() * 400);
    this.#base = `http://127.0.0.1:${port}`;
    this.#proc = spawn(geckodriverBinary(), ['--port', String(port)], { stdio: 'ignore' });
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      try {
        const r = await fetch(`${this.#base}/status`);
        if (r.ok) break;
      } catch {
        // not up yet
      }
    }
    const prefs: Record<string, unknown> = {
      'extensions.webextensions.uuids': JSON.stringify({ [FIREFOX_ID]: FIREFOX_UUID }),
      'browser.shell.checkDefaultBrowser': false,
      'datareporting.policy.dataSubmissionEnabled': false,
      ...this.#opts.prefs,
    };
    const created = await fetch(`${this.#base}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capabilities: {
          alwaysMatch: {
            browserName: 'firefox',
            webSocketUrl: true,
            'moz:firefoxOptions': {
              binary: firefoxBinary(),
              args: this.#opts.profileDir
                ? ['-headless', '-profile', this.#opts.profileDir]
                : ['-headless'],
              prefs,
            },
            timeouts: { script: 180_000, pageLoad: 45_000 },
          },
        },
      }),
    });
    const body = (await created.json()) as {
      value: {
        error?: string;
        message?: string;
        sessionId: string;
        capabilities: { browserVersion: string; webSocketUrl?: string };
      };
    };
    if (body.value.error) throw new Error(`firefox session: ${body.value.message}`);
    this.#sid = body.value.sessionId;
    this.version = body.value.capabilities.browserVersion;
    const wsUrl = body.value.capabilities.webSocketUrl;
    if (wsUrl) await this.#connectBidi(wsUrl).catch(() => null);
    await this.wd('POST', '/window/rect', { width: VIEWPORT.width, height: VIEWPORT.height + 120 });
    this.#current = (await this.wd('GET', '/window')) as string;
    if (this.#opts.extension !== false) {
      const id = (await this.wd('POST', '/moz/addon/install', {
        path: (this.#opts.extensionDir ?? path.join(ROOT, 'dist', 'firefox-mv2')).replace(
          /\\/g,
          '/',
        ),
        temporary: true,
      })) as string;
      if (id !== FIREFOX_ID) throw new Error(`unexpected add-on id ${id}`);
      this.#helper = await this.#newHandle();
      await this.select(this.#helper);
      await this.wd('POST', '/url', { url: `${this.extensionOrigin}/popup.html` });
    }
    return this;
  }

  async #newHandle(): Promise<string> {
    // After a tab was closed the session has no current window: pick a live one before opening the next.
    const handles = (await this.wd('GET', '/window/handles')) as string[];
    if (!handles.includes(this.#current) && handles[0]) {
      await this.wd('POST', '/window', { handle: handles[0] });
      this.#current = handles[0];
    }
    const w = (await this.wd('POST', '/window/new', { type: 'tab' })) as { handle: string };
    this.#current = '';
    return w.handle;
  }

  async #connectBidi(url: string): Promise<void> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('bidi socket'));
    });
    this.#ws = ws;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        method?: string;
        error?: string;
        result?: unknown;
        params?: {
          level?: string;
          text?: string;
          type?: string;
          source?: { realm?: string; context?: string };
          stackTrace?: { callFrames?: Array<{ url?: string }> };
        };
      };
      if (msg.id !== undefined) {
        this.#pending.get(msg.id)?.({ error: msg.error, result: msg.result });
        this.#pending.delete(msg.id);
        return;
      }
      if (msg.method === 'log.entryAdded' && msg.params) {
        const p = msg.params;
        if (p.level !== 'error' && p.level !== 'warn') return;
        const entry: LogEntry = {
          level: p.level,
          text: String(p.text ?? '').slice(0, 300),
          source: `${p.type ?? ''} ${p.stackTrace?.callFrames?.[0]?.url ?? ''}`.trim(),
        };
        const handle = p.source?.context ?? '';
        this.#logs.set(handle, [...(this.#logs.get(handle) ?? []), entry]);
        this.#logs.set('*', [...(this.#logs.get('*') ?? []), entry]);
      }
    };
    await this.#bidi('session.subscribe', { events: ['log.entryAdded'] });
  }

  #bidi(method: string, params: unknown): Promise<{ error?: string; result?: unknown }> {
    const id = ++this.#bidiId;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#ws?.send(JSON.stringify({ id, method, params }));
    });
  }

  async newTab(): Promise<Tab> {
    const handle = await this.#newHandle();
    await this.select(handle);
    return new FirefoxTab(this, handle);
  }

  async extensionTab(pagePath: string): Promise<Tab> {
    const tab = (await this.newTab()) as FirefoxTab;
    await tab.open(`${this.extensionOrigin}/${pagePath}`);
    return tab;
  }

  async extensionEval<T>(source: string): Promise<T> {
    if (!this.#helper) throw new Error('no extension loaded');
    const previous = this.#current;
    await this.select(this.#helper);
    try {
      return await this.run<T>(source);
    } finally {
      if (previous && previous !== this.#helper) await this.select(previous).catch(() => null);
    }
  }

  async setSettings(settings: Record<string, unknown>): Promise<void> {
    await this.extensionEval(
      `(async () => { const api = globalThis.browser ?? globalThis.chrome; await api.storage.local.set({ ${JSON.stringify(SETTINGS_KEY)}: ${JSON.stringify(settings)} }); })()`,
    );
  }

  getSettings(): Promise<unknown> {
    return this.extensionEval(
      `(async () => { const api = globalThis.browser ?? globalThis.chrome; return (await api.storage.local.get(${JSON.stringify(SETTINGS_KEY)}))[${JSON.stringify(SETTINGS_KEY)}]; })()`,
    );
  }

  /** `runtime.reload()` from the extension's own page: Firefox closes the extension's tabs, so the helper is rebuilt. */
  async reloadExtension(): Promise<void> {
    if (!this.#helper) throw new Error('no extension loaded');
    await this.extensionEval(`(globalThis.browser ?? globalThis.chrome).runtime.reload()`).catch(
      () => null,
    );
    await sleep(2500);
    this.#current = '';
    this.#helper = await this.#newHandle();
    await this.select(this.#helper);
    await this.wd('POST', '/url', { url: `${this.extensionOrigin}/popup.html` });
  }

  async close(): Promise<void> {
    try {
      this.#ws?.close();
      if (this.#sid) await fetch(`${this.#base}/session/${this.#sid}`, { method: 'DELETE' });
    } catch {
      // already gone
    }
    killTree(this.#proc);
  }
}

export async function startFirefox(opts: FirefoxOptions = {}): Promise<FirefoxDriver> {
  return new FirefoxDriver(opts).start();
}

export function startBrowser(name: BrowserName): Promise<Driver> {
  return name === 'chrome' ? startChrome() : startFirefox();
}
