/**
 * The M6.R1 adversarial semantic benchmark: scenarios that LOOK semantic but are not, evidence
 * that contradicts itself, components that are not peers, and the true positives that must keep
 * working. Pure data, shared by the jsdom benchmark (tests/) and the real-Chromium run (e2e/):
 * the same HTML and CSS, the same expectations, two engines.
 *
 * Expectations are properties (status, confidence, the cue as `placement glyph`), never pixels.
 * The hard gate is one number: automatic cues on a scenario that must not get one = 0.
 */

export type AdversarialCategory =
  | 'true-positive'
  | 'true-negative'
  | 'ambiguous'
  | 'conflict'
  | 'accessible'
  | 'trap'
  | 'peers'
  | 'token';

export interface AdversarialExpectation {
  readonly status: 'classified' | 'unknown' | 'conflict';
  readonly state?: string;
  readonly confidence?: 'high' | 'medium' | 'low';
  /** `null`: no cue. Otherwise `placement glyph` (`after ×`, `inner ✓`) or the placement (`underline`, `outline:dashed`). */
  readonly cue: string | null;
}

export interface AdversarialScenario {
  readonly name: string;
  readonly category: AdversarialCategory;
  readonly lang: 'en' | 'ru' | 'neutral';
  /** Whether the curated expectation is a high-confidence semantic the engine is allowed to miss (a false-negative candidate). */
  readonly curatedPositive?: boolean;
  readonly html: string;
  readonly expect: Readonly<Record<string, AdversarialExpectation>>;
}

export const ADVERSARIAL_CSS = `
  body { margin: 8px; font: 16px/1.4 sans-serif; color: #222222; background: #ffffff; }
  .status, .dotx { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
  .status.online { background-color: #27ae60; }
  .status.offline { background-color: #c0392b; }
  .status.warning { background-color: #f1c40f; }
  .badge, .chip, .tag, .pill { display: inline-block; padding: 2px 6px; color: #ffffff; background-color: #7f8c8d; margin-right: 6px; }
  .badge.success, .chip.success, .tag.success { background-color: #1e8449; }
  .badge.error, .chip.error, .tag.error { background-color: #c0392b; }
  .badge.warning, .chip.warning { background-color: #9a6a00; }
  .badge.info { background-color: #0b5ed7; }
  .tab { border: 0; background: none; color: #555555; font: inherit; }
  .tab[aria-selected="true"] { color: #0645ad; }
  .nav-link { color: #555555; text-decoration: none; }
  .nav-link.active, .nav-link[aria-current] { color: #0645ad; }
  .item { color: #555555; text-decoration: none; }
  .item.active, .item.selected { color: #0645ad; }
  .seg { border: 0; background: none; color: #555555; font: inherit; }
  .seg[aria-pressed="true"] { color: #0645ad; }
  .f { border: 1px solid #888888; }
  .f[aria-invalid="true"] { border-color: #c0392b; }
  label.field { color: #333333; }
  label.field.req { color: #c0392b; }
  .delta.positive { color: #27ae60; }
  .delta.negative { color: #c0392b; }
  .alert { padding: 4px; }
  .alert.error { background-color: #f8d7da; color: #721c24; }
  .alert.info { background-color: #d1ecf1; color: #0c5460; }
  .alert.success { background-color: #d4edda; color: #155724; }
  .req-star::after { content: "*"; }
  /* What a page-drawn ::after looks like to a real browser (the jsdom simulation reads the attribute directly). */
  [data-test-after]::after { content: attr(data-test-after); }
  .cell-status.ok { background-color: #27ae60; display: inline-block; width: 10px; height: 10px; }
  .cell-status.bad { background-color: #c0392b; display: inline-block; width: 10px; height: 10px; }
`;

const NONE: AdversarialExpectation = { status: 'unknown', cue: null };
const CONFLICT: AdversarialExpectation = { status: 'conflict', cue: null };
const low = (state: string): AdversarialExpectation => ({
  status: 'classified',
  state,
  confidence: 'low',
  cue: null,
});
const medium = (state: string): AdversarialExpectation => ({
  status: 'classified',
  state,
  confidence: 'medium',
  cue: null,
});
/** Strongly evidenced, but no cue: it already has a second channel, or nothing to compare with. */
const high = (state: string): AdversarialExpectation => ({
  status: 'classified',
  state,
  confidence: 'high',
  cue: null,
});
const cued = (state: string, cue: string): AdversarialExpectation => ({
  status: 'classified',
  state,
  confidence: 'high',
  cue,
});

const RED = 'color: #c0392b';
const GREEN = 'color: #27ae60';

export const ADVERSARIAL_SCENARIOS: readonly AdversarialScenario[] = [
  // ---- brand, decoration, ordinary colored content: color is not meaning ------------------------
  {
    name: 'red brand logo',
    category: 'trap',
    lang: 'neutral',
    html: `<div id="x" class="logo" style="${RED}">ACME</div>`,
    expect: { '#x': NONE },
  },
  {
    name: 'green brand logo',
    category: 'trap',
    lang: 'neutral',
    html: `<div id="x" class="logo" style="${GREEN}">Leaf</div>`,
    expect: { '#x': NONE },
  },
  {
    name: 'yellow decorative star',
    category: 'trap',
    lang: 'neutral',
    html: '<span id="x" class="star" style="color: #f1c40f">★</span>',
    expect: { '#x': NONE },
  },
  {
    name: 'red sale price next to a regular price',
    category: 'trap',
    lang: 'neutral',
    html: `<span id="x" class="price sale" style="${RED}">$9.99</span><span class="price">$19.99</span>`,
    expect: { '#x': NONE },
  },
  {
    name: 'green stock ticker without a sign',
    category: 'trap',
    lang: 'neutral',
    html: `<span id="x" class="ticker" style="${GREEN}">AAPL 182.50</span><span class="ticker" style="${RED}">TSLA 240.10</span>`,
    expect: { '#x': NONE, '.ticker + .ticker': NONE },
  },
  {
    name: 'red navigation link',
    category: 'trap',
    lang: 'neutral',
    html: `<nav><a id="x" class="nav-link" style="${RED}" href="#">Sale</a><a class="nav-link" href="#">Home</a></nav>`,
    expect: { '#x': NONE },
  },
  {
    name: 'green highlighted username',
    category: 'trap',
    lang: 'neutral',
    html: `<p>Posted by <a id="x" class="user" style="${GREEN}" href="#">alice</a></p>`,
    expect: { '#x': NONE },
  },
  {
    name: 'red avatar border',
    category: 'trap',
    lang: 'neutral',
    html: '<span id="x" class="avatar" style="display:inline-block;width:24px;height:24px;border-radius:50%;border:2px solid #c0392b"></span>',
    expect: { '#x': NONE },
  },
  {
    name: 'green progress decoration',
    category: 'trap',
    lang: 'neutral',
    html: '<div class="progress" style="width:100px;height:8px;background:#ddd"><div id="x" class="progress-bar" style="width:30%;height:8px;background:#27ae60"></div></div>',
    expect: { '#x': NONE },
  },
  {
    name: 'yellow rating stars',
    category: 'trap',
    lang: 'neutral',
    html: '<span id="x" class="rating" style="color:#f1c40f">★★★★☆</span>',
    expect: { '#x': NONE },
  },
  {
    name: 'red heart icon',
    category: 'trap',
    lang: 'neutral',
    html: `<span id="x" class="heart" style="${RED}">♥</span>`,
    expect: { '#x': NONE },
  },
  {
    name: 'a green check that only decorates (verified-looking, no state)',
    category: 'trap',
    lang: 'neutral',
    html: `<span id="x" class="verified" style="${GREEN}">✓</span>`,
    expect: { '#x': NONE },
  },
  {
    name: 'a blue "info-like" decorative badge',
    category: 'trap',
    lang: 'neutral',
    html: '<span id="x" class="badge" style="background-color:#0b5ed7">New</span><span class="badge">Beta</span>',
    expect: { '#x': NONE },
  },
  {
    name: 'a red word inside prose',
    category: 'trap',
    lang: 'neutral',
    html: `<p>The quick <span id="x" style="${RED}">red</span> fox jumps over the lazy dog.</p>`,
    expect: { '#x': NONE },
  },
  {
    name: 'a green word inside prose',
    category: 'trap',
    lang: 'neutral',
    html: `<p>Grass is <span id="x" style="${GREEN}">green</span> in the spring.</p>`,
    expect: { '#x': NONE },
  },
  {
    name: 'a red empty box that is just a swatch',
    category: 'trap',
    lang: 'neutral',
    html: '<span id="x" class="swatch" style="display:inline-block;width:12px;height:12px;background:#c0392b"></span><span class="swatch" style="display:inline-block;width:12px;height:12px;background:#27ae60"></span>',
    expect: { '#x': NONE },
  },
  {
    name: 'a color picker palette of status-colored squares',
    category: 'trap',
    lang: 'neutral',
    html: '<div class="palette"><span id="a" class="color" style="display:inline-block;width:14px;height:14px;background:#27ae60"></span><span id="b" class="color" style="display:inline-block;width:14px;height:14px;background:#c0392b"></span></div>',
    expect: { '#a': NONE, '#b': NONE },
  },
  {
    name: 'a red link inside a paragraph',
    category: 'trap',
    lang: 'neutral',
    html: `<p>See <a id="x" href="#" style="${RED}">the policy</a> for details.</p>`,
    expect: { '#x': NONE },
  },
  {
    name: 'a green button (a primary action, not a state)',
    category: 'trap',
    lang: 'neutral',
    html: '<button id="x" class="primary" style="background:#27ae60;color:#fff">Continue</button><button class="secondary">Back</button>',
    expect: { '#x': NONE },
  },
  {
    name: 'a red table cell (data, not a state)',
    category: 'trap',
    lang: 'neutral',
    html: `<table><tr><td id="x" class="cell" style="${RED}">-4.2</td><td class="cell">3.1</td></tr></table>`,
    expect: { '#x': NONE },
  },
  // ---- class and attribute names that merely look like state words ------------------------------
  {
    name: 'class terror',
    category: 'token',
    lang: 'neutral',
    html: '<p id="x" class="terror">x</p>',
    expect: { '#x': NONE },
  },
  {
    name: 'class successor',
    category: 'token',
    lang: 'neutral',
    html: '<p id="x" class="successor">x</p>',
    expect: { '#x': NONE },
  },
  {
    name: 'class invalidated',
    category: 'token',
    lang: 'neutral',
    html: '<p id="x" class="invalidated">x</p>',
    expect: { '#x': NONE },
  },
  {
    name: 'class warningly',
    category: 'token',
    lang: 'neutral',
    html: '<p id="x" class="warningly">x</p>',
    expect: { '#x': NONE },
  },
  {
    name: 'class errorless',
    category: 'token',
    lang: 'neutral',
    html: '<p id="x" class="errorless">x</p>',
    expect: { '#x': NONE },
  },
  {
    name: 'class inactiveUser (the state word is the topic, not a state)',
    category: 'token',
    lang: 'neutral',
    html: '<span id="x" class="inactiveUser">bob</span><span class="inactiveUser">carol</span>',
    expect: { '#x': NONE },
  },
  {
    name: 'class error-prone',
    category: 'token',
    lang: 'neutral',
    html: '<span id="x" class="badge error-prone">Linting</span><span class="badge">Types</span>',
    expect: { '#x': NONE },
  },
  {
    name: 'class success-stories',
    category: 'token',
    lang: 'neutral',
    html: '<h3 id="x" class="success-stories">Our customers</h3>',
    expect: { '#x': NONE },
  },
  {
    name: 'class online-users (a count of people, not a presence state)',
    category: 'token',
    lang: 'neutral',
    html: '<span id="x" class="online-users">128</span>',
    expect: { '#x': NONE },
  },
  {
    name: 'class warning-yellow (a color name, not a warning)',
    category: 'token',
    lang: 'neutral',
    html: '<span id="x" class="badge warning-yellow">Note</span><span class="badge">Other</span>',
    expect: { '#x': NONE },
  },
  {
    name: 'class danger-zone',
    category: 'token',
    lang: 'neutral',
    html: '<section id="x" class="danger-zone">Settings</section>',
    expect: { '#x': NONE },
  },
  {
    name: 'class btn-danger / btn-success / btn-warning are button variants',
    category: 'token',
    lang: 'neutral',
    html: '<button id="a" class="btn btn-danger">Delete</button><button id="b" class="btn btn-success">Save</button><button id="c" class="btn btn-warning">Reset</button>',
    expect: { '#a': NONE, '#b': NONE, '#c': NONE },
  },
  {
    name: 'a button whose class contains danger-like substrings',
    category: 'token',
    lang: 'neutral',
    html: '<button id="x" class="btn dangerous endangered">Go</button>',
    expect: { '#x': NONE },
  },
  {
    name: 'data-state="error-prone"',
    category: 'token',
    lang: 'neutral',
    html: '<span id="x" class="badge" data-state="error-prone">Linting</span><span class="badge">Types</span>',
    expect: { '#x': NONE },
  },
  {
    name: 'data-state="not-error"',
    category: 'token',
    lang: 'neutral',
    html: '<span id="x" class="badge" data-state="not-error">Linting</span><span class="badge">Types</span>',
    expect: { '#x': NONE },
  },
  {
    name: 'data-theme="warning-yellow" is not a state attribute',
    category: 'token',
    lang: 'neutral',
    html: '<div id="x" class="card" data-theme="warning-yellow">Card</div>',
    expect: { '#x': NONE },
  },
  {
    name: 'data-status="successful" on a plain span is only medium evidence',
    category: 'token',
    lang: 'neutral',
    html: '<span id="x" data-status="successful">Order 7</span><span>Order 8</span>',
    expect: { '#x': medium('success') },
  },
  {
    name: 'data-state="error" on a plain span is only medium evidence',
    category: 'token',
    lang: 'neutral',
    html: '<span id="x" data-state="error">Order 7</span><span>Order 8</span>',
    expect: { '#x': medium('error') },
  },
  {
    name: 'data-kind="info-box" is an info callout: MEDIUM, reported and never applied',
    category: 'token',
    lang: 'neutral',
    html: '<div id="x" data-kind="info-box">Tip</div>',
    expect: { '#x': medium('info') },
  },
  {
    name: 'id-only evidence (id="error") is weak: nothing',
    category: 'token',
    lang: 'neutral',
    html: '<div id="error">Something</div><div id="success">Else</div>',
    expect: { '#error': NONE, '#success': NONE },
  },
  {
    name: 'class errors-page is not a state; the word "Errors" alone is only LOW',
    category: 'token',
    lang: 'neutral',
    html: '<div id="x" class="errors-page">Errors</div>',
    expect: { '#x': low('error') },
  },
  // ---- words in text -----------------------------------------------------------------------------
  {
    name: '"No errors" means the opposite',
    category: 'true-negative',
    lang: 'en',
    html: '<span id="x">No errors</span>',
    expect: { '#x': NONE },
  },
  {
    name: '"Error handling guide" is a title',
    category: 'true-negative',
    lang: 'en',
    html: '<a id="x" href="#">Error handling guide</a>',
    expect: { '#x': low('error') },
  },
  {
    name: '"Successful examples" is a title',
    category: 'true-negative',
    lang: 'en',
    html: '<h3 id="x">Successful examples</h3>',
    expect: { '#x': low('success') },
  },
  {
    name: 'a product named "Warning"',
    category: 'true-negative',
    lang: 'en',
    html: '<h3 id="x" class="product-name">Warning</h3><h3 class="product-name">Caution tape</h3>',
    expect: { '#x': low('warning') },
  },
  {
    name: 'a brand named "Success"',
    category: 'true-negative',
    lang: 'en',
    html: '<a id="x" class="brand" href="#">Success</a>',
    expect: { '#x': low('success') },
  },
  {
    name: 'a person named Invalid (a surname) in a table',
    category: 'true-negative',
    lang: 'en',
    html: '<table><tr><td id="x" class="person">Invalid</td><td class="person">Valid</td></tr></table>',
    expect: { '#x': low('invalid') },
  },
  {
    name: 'prose that mentions an error',
    category: 'true-negative',
    lang: 'en',
    html: '<p id="x">We are sorry, an error occurred while loading the page for you today</p>',
    expect: { '#x': NONE },
  },
  {
    name: '"Without errors"',
    category: 'true-negative',
    lang: 'en',
    html: '<span id="x">Without errors</span>',
    expect: { '#x': NONE },
  },
  {
    name: '"Never failed"',
    category: 'true-negative',
    lang: 'en',
    html: '<span id="x">Never failed</span>',
    expect: { '#x': NONE },
  },
  {
    name: '"Не ошибка" (not an error)',
    category: 'true-negative',
    lang: 'ru',
    html: '<span id="x">Не ошибка</span>',
    expect: { '#x': NONE },
  },
  {
    name: '"Без ошибок" (without errors)',
    category: 'true-negative',
    lang: 'ru',
    html: '<span id="x">Без ошибок</span>',
    expect: { '#x': NONE },
  },
  {
    name: '"Нет ошибок" (no errors)',
    category: 'true-negative',
    lang: 'ru',
    html: '<span id="x">Нет ошибок</span>',
    expect: { '#x': NONE },
  },
  {
    name: '"Успешно" alone is LOW',
    category: 'ambiguous',
    lang: 'ru',
    html: '<span id="x">Успешно</span>',
    expect: { '#x': low('success') },
  },
  {
    name: '"Ошибка" alone is LOW',
    category: 'ambiguous',
    lang: 'ru',
    html: '<span id="x">Ошибка</span>',
    expect: { '#x': low('error') },
  },
  {
    name: 'a long Russian sentence that mentions an error is prose',
    category: 'true-negative',
    lang: 'ru',
    html: '<p id="x">К сожалению, при загрузке страницы произошла ошибка, попробуйте позже</p>',
    expect: { '#x': NONE },
  },
  {
    name: 'a Russian title "Руководство по обработке ошибок"',
    category: 'true-negative',
    lang: 'ru',
    html: '<h3 id="x">Руководство по обработке ошибок</h3>',
    expect: { '#x': low('error') },
  },
  {
    name: 'Required in prose ("required reading")',
    category: 'true-negative',
    lang: 'en',
    html: '<h3 id="x" class="course">Required reading</h3>',
    expect: { '#x': low('required') },
  },
  {
    name: 'a link labelled "Online store"',
    category: 'true-negative',
    lang: 'en',
    html: '<a id="x" href="#" class="nav-link">Online store</a><a href="#" class="nav-link">Offline stores</a>',
    expect: { '#x': low('online') },
  },
  {
    name: 'an aria-label that names a state on a plain control: LOW',
    category: 'ambiguous',
    lang: 'en',
    html: '<span id="x" aria-label="Warning">!</span>',
    expect: { '#x': low('warning') },
  },
  {
    name: 'a title attribute that says "Error log"',
    category: 'true-negative',
    lang: 'en',
    html: '<a id="x" href="#" title="Error log">Logs</a>',
    expect: { '#x': low('error') },
  },
  // ---- conflicting evidence ----------------------------------------------------------------------
  {
    name: 'class success + aria-invalid="true"',
    category: 'conflict',
    lang: 'neutral',
    html: '<div id="x" class="success" aria-invalid="true">Order</div>',
    expect: { '#x': CONFLICT },
  },
  {
    name: 'class warning + data-state="success"',
    category: 'conflict',
    lang: 'neutral',
    html: '<div id="x" class="warning" data-state="success">Order</div>',
    expect: { '#x': CONFLICT },
  },
  {
    name: 'aria-selected="true" + class inactive (a tab)',
    category: 'conflict',
    lang: 'neutral',
    html: '<div role="tablist"><button id="x" role="tab" class="tab inactive" aria-selected="true">Home</button><button role="tab" class="tab" aria-selected="false">Docs</button></div>',
    expect: { '#x': CONFLICT },
  },
  {
    name: 'role=alert + class success: the alert hint does not apply, nothing is guessed',
    category: 'conflict',
    lang: 'neutral',
    html: '<div id="x" role="alert" class="success">Saved</div>',
    expect: { '#x': medium('success') },
  },
  {
    name: 'class error + class success on one element',
    category: 'conflict',
    lang: 'neutral',
    html: '<span id="x" class="badge error success">Order</span>',
    expect: { '#x': CONFLICT },
  },
  {
    name: 'online + offline classes',
    category: 'conflict',
    lang: 'neutral',
    html: '<span id="x" class="status online offline"></span>',
    expect: { '#x': CONFLICT },
  },
  {
    name: 'aria-invalid="true" + class valid',
    category: 'conflict',
    lang: 'neutral',
    html: '<input id="x" class="f valid" aria-invalid="true"><input class="f">',
    expect: { '#x': CONFLICT },
  },
  {
    name: 'class success, text "Failed"',
    category: 'conflict',
    lang: 'en',
    html: '<span id="x" class="badge success">Failed</span>',
    expect: { '#x': CONFLICT },
  },
  {
    name: 'class success, Russian text "Ошибка"',
    category: 'conflict',
    lang: 'ru',
    html: '<span id="x" class="badge success">Ошибка</span>',
    expect: { '#x': CONFLICT },
  },
  {
    name: 'aria-pressed="true" + class inactive',
    category: 'conflict',
    lang: 'neutral',
    html: '<button id="x" class="seg inactive" aria-pressed="true">Day</button><button class="seg" aria-pressed="false">Week</button>',
    expect: { '#x': CONFLICT },
  },
  {
    name: 'aria-current + class inactive',
    category: 'conflict',
    lang: 'neutral',
    html: '<nav><a id="x" class="nav-link inactive" aria-current="page" href="#">Home</a><a class="nav-link" href="#">About</a></nav>',
    expect: { '#x': CONFLICT },
  },
  // ---- compatible dimensions: nothing is overwritten ----------------------------------------------
  {
    name: 'selected + disabled: the tab keeps both, the selected underline is not lost',
    category: 'true-positive',
    lang: 'neutral',
    html: '<div role="tablist"><button id="x" role="tab" class="tab" aria-selected="true" aria-disabled="true">Home</button><button role="tab" class="tab" aria-selected="false">Docs</button></div>',
    expect: { '#x': cued('selected', 'underline') },
  },
  {
    name: 'required + invalid on one field: the invalid pattern (the dashed outline) wins as the louder state',
    category: 'true-positive',
    lang: 'neutral',
    html: '<input id="x" class="f" required aria-invalid="true"><input class="f">',
    expect: { '#x': cued('invalid', 'outline:dashed') },
  },
  {
    name: 'active + selected: one class of meaning (on), one underline',
    category: 'true-positive',
    lang: 'neutral',
    html: '<nav><a id="x" class="nav-link active selected" aria-current="page" href="#">Home</a><a class="nav-link" href="#">About</a></nav>',
    expect: { '#x': cued('active', 'underline') },
  },
  {
    name: 'checked + disabled checkbox: disabled by native state, no glyph on a native control',
    category: 'accessible',
    lang: 'neutral',
    html: '<input id="x" type="checkbox" checked disabled><input type="checkbox">',
    expect: { '#x': high('disabled') },
  },
  {
    name: 'aria-checked + aria-disabled switch: no cue for either',
    category: 'accessible',
    lang: 'neutral',
    html: '<div id="x" role="switch" aria-checked="true" aria-disabled="true" tabindex="0">Wi-Fi</div><div role="switch" aria-checked="false" tabindex="0">Bluetooth</div>',
    expect: { '#x': high('selected') },
  },
  {
    name: 'disabled button: native semantics, never a cue',
    category: 'accessible',
    lang: 'neutral',
    html: '<button id="x" disabled class="btn">Save</button><button class="btn">Cancel</button>',
    expect: { '#x': high('disabled') },
  },
  {
    name: 'aria-disabled link: no cue',
    category: 'accessible',
    lang: 'neutral',
    html: '<a id="x" href="#" aria-disabled="true" class="nav-link">Soon</a><a href="#" class="nav-link">Now</a>',
    expect: { '#x': high('disabled') },
  },
  // ---- peers that must NOT be grouped --------------------------------------------------------------
  {
    name: 'same parent, different component types (badge vs chip)',
    category: 'peers',
    lang: 'neutral',
    html: '<div><span id="x" class="badge success">Order 1</span><span class="chip error">Order 2</span></div>',
    expect: { '#x': high('success') },
  },
  {
    name: 'same class, different role: a tab is not a plain badge',
    category: 'peers',
    lang: 'neutral',
    html: '<div><span id="x" class="badge success" role="status">Order 1</span><span class="badge error">Order 2</span></div>',
    expect: { '#x': high('success') },
  },
  {
    name: 'same geometry, different purpose: a status badge next to a counter pill',
    category: 'peers',
    lang: 'neutral',
    html: '<div><span id="x" class="badge success">12</span><span class="pill">99</span></div>',
    expect: { '#x': high('success') },
  },
  {
    name: 'same text length, different control type: input vs button',
    category: 'peers',
    lang: 'neutral',
    html: '<div><input id="x" class="f" aria-invalid="true" value="abcd"><button class="f">abcd</button></div>',
    expect: { '#x': high('invalid') },
  },
  {
    name: 'two lists under one parent: an active item in the first is not compared with the second list',
    category: 'peers',
    lang: 'neutral',
    html: '<div><ul class="main"><li><a id="x" class="item active" aria-current="page" href="#">Home</a></li></ul><ul class="footer"><li><a class="item" href="#">Terms</a></li></ul></div>',
    expect: { '#x': high('active') },
  },
  {
    name: 'nested repeated components: a badge in a card is not compared with a badge in a toolbar',
    category: 'peers',
    lang: 'neutral',
    html: '<div><div class="card"><span id="x" class="badge success">Paid</span></div><div class="toolbar"><span class="badge">3</span></div></div>',
    expect: { '#x': high('success') },
  },
  {
    name: 'tabs and chips side by side: only tabs are compared with tabs',
    category: 'peers',
    lang: 'neutral',
    html: '<div><div role="tablist"><button id="x" role="tab" class="tab" aria-selected="true">One</button></div><div class="chips"><button class="tab" aria-selected="false" role="tab">Two</button></div></div>',
    expect: { '#x': high('selected') },
  },
  {
    name: 'a lone success badge: nothing to compare with, so color-only cannot be shown',
    category: 'peers',
    lang: 'neutral',
    html: '<span id="x" class="badge success">Order 1</span>',
    expect: { '#x': high('success') },
  },
  {
    name: 'a lone selected tab',
    category: 'peers',
    lang: 'neutral',
    html: '<div role="tablist"><button id="x" role="tab" class="tab" aria-selected="true">Home</button></div>',
    expect: { '#x': high('selected') },
  },
  {
    name: 'a lone invalid field',
    category: 'peers',
    lang: 'neutral',
    html: '<input id="x" class="f" aria-invalid="true">',
    expect: { '#x': high('invalid') },
  },
  // ---- true peers: the cue is added ----------------------------------------------------------------
  {
    name: 'tabs: the selected one is underlined',
    category: 'true-positive',
    lang: 'neutral',
    curatedPositive: true,
    html: '<div role="tablist"><button id="a" role="tab" class="tab" aria-selected="true">One</button><button id="b" role="tab" class="tab" aria-selected="false">Two</button><button id="c" role="tab" class="tab" aria-selected="false">Three</button></div>',
    expect: {
      '#a': cued('selected', 'underline'),
      '#b': high('unselected'),
      '#c': high('unselected'),
    },
  },
  {
    name: 'status dots: online and offline',
    category: 'true-positive',
    lang: 'neutral',
    curatedPositive: true,
    html: '<span id="a" class="status online"></span><span id="b" class="status offline"></span>',
    expect: { '#a': cued('online', 'inner ✓'), '#b': cued('offline', 'inner ×') },
  },
  {
    name: 'repeated badges: success and error with no state word',
    category: 'true-positive',
    lang: 'neutral',
    curatedPositive: true,
    html: '<span id="a" class="badge success">Order 1</span><span id="b" class="badge error">Order 2</span>',
    expect: { '#a': cued('success', 'after ✓'), '#b': cued('error', 'after ×') },
  },
  {
    name: 'repeated badges with a neutral one: the state ones still differ by color only',
    category: 'true-positive',
    lang: 'neutral',
    curatedPositive: true,
    html: '<span id="a" class="badge success">Order 1</span><span class="badge">Order 2</span><span id="b" class="badge error">Order 3</span>',
    expect: { '#a': cued('success', 'after ✓'), '#b': cued('error', 'after ×') },
  },
  {
    name: 'segmented control: the pressed segment is underlined',
    category: 'true-positive',
    lang: 'neutral',
    curatedPositive: true,
    html: '<div role="group"><button id="a" class="seg" aria-pressed="true">Day</button><button id="b" class="seg" aria-pressed="false">Week</button></div>',
    expect: { '#a': cued('active', 'underline'), '#b': high('inactive') },
  },
  {
    name: 'navigation items: the current page is underlined',
    category: 'true-positive',
    lang: 'neutral',
    curatedPositive: true,
    html: '<nav><a id="a" class="nav-link" aria-current="page" href="#">Home</a><a id="b" class="nav-link" href="#">About</a><a class="nav-link" href="#">Blog</a></nav>',
    expect: { '#a': cued('active', 'underline'), '#b': NONE },
  },
  {
    name: 'list rows with a repeated status cell',
    category: 'true-positive',
    lang: 'neutral',
    curatedPositive: true,
    html: '<table><tr><td>Job A</td><td id="a" class="cell-status ok" data-status="success"></td></tr><tr><td>Job B</td><td id="b" class="cell-status bad" data-status="error"></td></tr></table>',
    expect: { '#a': cued('success', 'inner ✓'), '#b': cued('error', 'inner ×') },
  },
  {
    name: 'invalid field among valid ones: dashed outline',
    category: 'true-positive',
    lang: 'neutral',
    curatedPositive: true,
    html: '<input id="a" class="f" aria-invalid="true"><input id="b" class="f"><input id="c" class="f">',
    expect: { '#a': cued('invalid', 'outline:dashed'), '#b': NONE, '#c': NONE },
  },
  {
    name: 'required label drawn only in red gets a star',
    category: 'true-positive',
    lang: 'neutral',
    curatedPositive: true,
    html: '<label id="l1" class="field req" for="e">Email</label><input id="e" required><label id="l2" class="field" for="n">Name</label><input id="n">',
    expect: { '#l1': cued('required', 'after *'), '#e': high('required'), '#l2': NONE },
  },
  {
    name: 'positive and negative deltas without a sign',
    category: 'true-positive',
    lang: 'neutral',
    curatedPositive: true,
    html: '<span id="p" class="delta positive">12%</span><span id="n" class="delta negative">8%</span>',
    expect: { '#p': cued('positive', 'after +'), '#n': cued('negative', 'after −') },
  },
  {
    name: 'alerts: error and info differ by color only',
    category: 'true-positive',
    lang: 'neutral',
    curatedPositive: true,
    html: '<div id="e" role="alert" class="alert error">Something happened</div><div id="i" role="alert" class="alert info">Something else</div>',
    expect: { '#e': cued('error', 'after ×'), '#i': cued('info', 'after ℹ') },
  },
  {
    name: 'a success alert next to an error alert',
    category: 'true-positive',
    lang: 'neutral',
    curatedPositive: true,
    html: '<div id="e" class="alert error" role="alert">Card declined soon</div><div id="s" class="alert success" role="alert">Card saved soon</div>',
    expect: { '#e': cued('error', 'after ×'), '#s': cued('success', 'after ✓') },
  },
  {
    name: 'a warning dot among online and offline dots',
    category: 'true-positive',
    lang: 'neutral',
    curatedPositive: true,
    html: '<span class="status online"></span><span class="status offline"></span><span id="w" class="status warning"></span>',
    expect: { '#w': cued('warning', 'inner !') },
  },
  // ---- already accessible: nothing to add -------------------------------------------------------------
  {
    name: 'badges whose text names the state (English)',
    category: 'accessible',
    lang: 'en',
    html: '<span id="a" class="badge success">Success</span><span id="b" class="badge error">Error</span>',
    expect: { '#a': high('success'), '#b': high('error') },
  },
  {
    name: 'badges whose text names the state (Russian)',
    category: 'accessible',
    lang: 'ru',
    html: '<span id="a" class="badge success">Успешно</span><span id="b" class="badge error">Ошибка</span>',
    expect: { '#a': high('success'), '#b': high('error') },
  },
  {
    name: 'a badge with a symbol in its text',
    category: 'accessible',
    lang: 'neutral',
    html: '<span id="a" class="badge success">✓ Order 1</span><span id="b" class="badge error">× Order 2</span>',
    expect: { '#a': high('success'), '#b': high('error') },
  },
  {
    name: 'a badge whose ::after the page draws',
    category: 'accessible',
    lang: 'neutral',
    html: '<span id="a" class="badge success" data-test-after="✓">Order 1</span><span id="b" class="badge error">Order 2</span>',
    expect: { '#a': high('success'), '#b': cued('error', 'after ×') },
  },
  {
    name: 'a dot that is bigger than its peers: size is a second channel',
    category: 'accessible',
    lang: 'neutral',
    html: '<span id="a" class="status online"></span><span id="b" class="status offline" style="width:14px;height:14px"></span>',
    expect: { '#a': high('online'), '#b': high('offline') },
  },
  {
    name: 'a selected tab that is bold',
    category: 'accessible',
    lang: 'neutral',
    html: '<div role="tablist"><button id="a" role="tab" class="tab" style="font-weight:700" aria-selected="true">One</button><button role="tab" class="tab" aria-selected="false">Two</button></div>',
    expect: { '#a': high('selected') },
  },
  {
    name: 'a selected tab that is already underlined',
    category: 'accessible',
    lang: 'neutral',
    html: '<div role="tablist"><button id="a" role="tab" class="tab" style="text-decoration-line:underline" aria-selected="true">One</button><button role="tab" class="tab" style="text-decoration-line:underline" aria-selected="false">Two</button></div>',
    expect: { '#a': high('selected') },
  },
  {
    name: 'an invalid field that is also thicker than the valid one',
    category: 'accessible',
    lang: 'neutral',
    html: '<input id="a" class="f" style="border-top-width:3px" aria-invalid="true"><input class="f">',
    expect: { '#a': high('invalid') },
  },
  {
    name: 'a required label that already says *',
    category: 'accessible',
    lang: 'neutral',
    html: '<label id="l1" class="field req" for="e">Email *</label><input id="e" required><label class="field" for="n">Name</label><input id="n">',
    expect: { '#l1': high('required') },
  },
  {
    name: 'a required label with a page-drawn star',
    category: 'accessible',
    lang: 'neutral',
    html: '<label id="l1" class="field req req-star" data-test-after="*" for="e">Email</label><input id="e" required><label class="field" for="n">Name</label><input id="n">',
    expect: { '#l1': high('required') },
  },
  {
    name: 'a required label that says "(required)"',
    category: 'accessible',
    lang: 'en',
    html: '<label id="l1" class="field req" for="e">Email (required)</label><input id="e" required><label class="field" for="n">Name</label><input id="n">',
    expect: { '#l1': high('required') },
  },
  {
    name: 'a required label that says "(обязательно)"',
    category: 'accessible',
    lang: 'ru',
    html: '<label id="l1" class="field req" for="e">Почта (обязательно)</label><input id="e" required><label class="field" for="n">Имя</label><input id="n">',
    expect: { '#l1': high('required') },
  },
  {
    name: 'deltas that carry their own sign',
    category: 'accessible',
    lang: 'neutral',
    html: '<span id="p" class="delta positive">+12%</span><span id="n" class="delta negative">-8%</span>',
    expect: { '#p': high('positive'), '#n': high('negative') },
  },
  {
    name: 'a badge with a plus-sign in an arithmetic expression text is a symbol already',
    category: 'accessible',
    lang: 'neutral',
    html: '<span id="p" class="delta positive">2 + 2</span><span id="n" class="delta negative">8</span>',
    expect: { '#p': high('positive'), '#n': cued('negative', 'after −') },
  },
  {
    name: 'a warning badge with an SVG triangle: no duplicate marker (M5 icon is the cue)',
    category: 'accessible',
    lang: 'neutral',
    html: '<span id="a" class="badge warning"><svg width="12" height="12" viewBox="0 0 12 12"><path d="M0 12L6 0L12 12Z"/></svg> Order 1</span><span id="b" class="badge success">Order 2</span>',
    expect: { '#a': high('warning'), '#b': high('success') },
  },
  {
    name: 'an error state with a real SVG error icon: no duplicate marker',
    category: 'accessible',
    lang: 'neutral',
    html: '<span id="a" class="badge error"><svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 1L11 11M11 1L1 11"/></svg> Order 1</span><span class="badge success">Order 2</span>',
    expect: { '#a': high('error') },
  },
  {
    name: 'a decorative red SVG logo carries no semantics',
    category: 'trap',
    lang: 'neutral',
    html: '<span id="x" class="brand"><svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#c0392b"/></svg></span>',
    expect: { '#x': NONE },
  },
  {
    name: 'a decorative SVG that looks like a warning icon, with no state',
    category: 'trap',
    lang: 'neutral',
    html: '<span id="x" class="deco"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M0 16L8 0L16 16Z" fill="#f1c40f"/></svg></span>',
    expect: { '#x': NONE },
  },
  {
    name: 'an img icon with alt="error" is already a cue',
    category: 'accessible',
    lang: 'neutral',
    html: '<span id="a" class="badge error"><img alt="error" src="data:,"> Order 1</span><span class="badge success">Order 2</span>',
    expect: { '#a': high('error') },
  },
  {
    name: 'an icon-font glyph is already a cue',
    category: 'accessible',
    lang: 'neutral',
    html: '<span id="a" class="badge error"><i class="fa fa-times"></i> Order 1</span><span class="badge success">Order 2</span>',
    expect: { '#a': high('error') },
  },
  {
    name: 'a required star used decoratively on a heading (no required state)',
    category: 'trap',
    lang: 'neutral',
    html: '<h3 id="x" class="title">Features *</h3>',
    expect: { '#x': NONE },
  },
  {
    name: 'a plus sign as arithmetic text, no state',
    category: 'trap',
    lang: 'neutral',
    html: '<span id="x" class="calc">2 + 2 = 4</span>',
    expect: { '#x': NONE },
  },
  {
    name: 'a minus sign in a product code, no state',
    category: 'trap',
    lang: 'neutral',
    html: '<span id="x" class="sku">SKU-4411</span>',
    expect: { '#x': NONE },
  },
  {
    name: 'underline used as general styling, no state',
    category: 'trap',
    lang: 'neutral',
    html: '<span id="x" class="u" style="text-decoration:underline">Terms</span><span class="u" style="text-decoration:underline">Privacy</span>',
    expect: { '#x': NONE },
  },
  {
    name: 'bold selected text vs a bold heading: a heading is not a selection',
    category: 'trap',
    lang: 'neutral',
    html: '<h2 id="x" class="heading" style="font-weight:700">Overview</h2><p>Text</p>',
    expect: { '#x': NONE },
  },
  {
    name: 'a selected option inside a native <select> is native state, not a color cue',
    category: 'accessible',
    lang: 'neutral',
    html: '<select id="s"><option id="x" selected>One</option><option>Two</option></select>',
    expect: { '#x': NONE },
  },
  // ---- ambiguous evidence: reported, never applied --------------------------------------------------------
  {
    name: 'one status class on a paragraph is MEDIUM',
    category: 'ambiguous',
    lang: 'neutral',
    html: '<p id="x" class="warning">Check your settings</p><p>Another paragraph</p>',
    expect: { '#x': medium('warning') },
  },
  {
    name: 'one active class on a plain list item is MEDIUM',
    category: 'ambiguous',
    lang: 'neutral',
    html: '<ul><li id="x" class="active">One</li><li>Two</li></ul>',
    expect: { '#x': medium('active') },
  },
  {
    name: 'role=alert alone does not choose between error and warning',
    category: 'ambiguous',
    lang: 'neutral',
    html: '<div id="x" role="alert">Something happened</div>',
    expect: { '#x': NONE },
  },
  {
    name: 'role=status alone says nothing about success',
    category: 'ambiguous',
    lang: 'neutral',
    html: '<div id="x" role="status">Loading</div>',
    expect: { '#x': NONE },
  },
  {
    name: 'aria-live alone',
    category: 'ambiguous',
    lang: 'neutral',
    html: '<div id="x" aria-live="polite">Updated</div>',
    expect: { '#x': NONE },
  },
  {
    name: 'aria-invalid="false" says nothing',
    category: 'ambiguous',
    lang: 'neutral',
    html: '<input id="x" class="f" aria-invalid="false"><input class="f">',
    expect: { '#x': NONE },
  },
  {
    name: 'aria-current="false" says nothing',
    category: 'ambiguous',
    lang: 'neutral',
    html: '<nav><a id="x" class="nav-link" aria-current="false" href="#">Home</a><a class="nav-link" href="#">About</a></nav>',
    expect: { '#x': NONE },
  },
  {
    name: 'an untouched required input is required, not invalid',
    category: 'ambiguous',
    lang: 'neutral',
    html: '<input id="x" required class="f"><input class="f">',
    expect: { '#x': high('required') },
  },
  {
    name: 'a color that merely resembles a state (red text, class "msg") is weak evidence',
    category: 'ambiguous',
    lang: 'neutral',
    html: `<p id="x" class="msg" style="${RED}">Check the form</p>`,
    expect: { '#x': NONE },
  },
  {
    name: 'a red box with the word "Failed" inside is MEDIUM (a word, color agrees, no structure)',
    category: 'ambiguous',
    lang: 'en',
    html: `<span id="x" style="${RED}">Failed</span>`,
    expect: { '#x': medium('error') },
  },
  {
    name: 'a green box with the word "Success" inside is MEDIUM',
    category: 'ambiguous',
    lang: 'en',
    html: `<span id="x" style="${GREEN}">Success</span>`,
    expect: { '#x': medium('success') },
  },
  {
    name: 'a button labelled "Retry after error"',
    category: 'ambiguous',
    lang: 'en',
    html: '<button id="x" class="btn">Retry after error</button>',
    expect: { '#x': low('error') },
  },
  // ---- class and ARIA agree: strong enough ---------------------------------------------------------------
  {
    name: 'aria-invalid on a field with a validation class',
    category: 'true-positive',
    lang: 'neutral',
    html: '<input id="a" class="f has-error" aria-invalid="true"><input class="f">',
    expect: { '#a': cued('invalid', 'outline:dashed') },
  },
  {
    name: 'a badge with class and data-state agreeing',
    category: 'true-positive',
    lang: 'neutral',
    html: '<span id="a" class="badge success" data-state="success">Order 1</span><span class="badge error" data-state="error">Order 2</span>',
    expect: { '#a': cued('success', 'after ✓') },
  },
  {
    name: 'a badge in a status list: class + context make it HIGH',
    category: 'true-positive',
    lang: 'neutral',
    html: '<ul class="status-list"><li><span id="a" class="chip success">Build 1</span></li><li><span class="chip error">Build 2</span></li></ul>',
    expect: { '#a': cued('success', 'after ✓') },
  },
  {
    name: 'a presence dot with a data-state attribute',
    category: 'true-positive',
    lang: 'neutral',
    html: '<span id="a" class="dotx" data-state="online" style="background:#27ae60"></span><span class="dotx" data-state="offline" style="background:#c0392b"></span>',
    expect: { '#a': medium('online') },
  },
];
