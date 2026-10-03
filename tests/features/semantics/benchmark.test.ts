import { afterEach, describe, expect, it } from 'vitest';
import { $, cueOf, describeCue, mount, teardown } from './kit';

/**
 * The deterministic semantic benchmark (docs/SEMANTIC_ACCESSIBILITY.md, "Benchmark"): one
 * fixture per scenario, expectations stated as properties (classified / unknown / conflict,
 * confidence, cue or no cue, cue kind), never as pixels.
 */

type Category =
  | 'success'
  | 'error'
  | 'warning'
  | 'info'
  | 'selected'
  | 'active'
  | 'invalid'
  | 'required'
  | 'presence'
  | 'sign'
  | 'ambiguous'
  | 'conflict'
  | 'accessible'
  | 'false-positive';

interface Expectation {
  readonly status: 'classified' | 'unknown' | 'conflict';
  readonly state?: string;
  readonly confidence?: 'high' | 'medium' | 'low';
  /** `null`: no cue. Otherwise the cue as `placement glyph` or just the placement. */
  readonly cue: string | null;
}

interface Scenario {
  readonly name: string;
  readonly category: Category;
  readonly html: string;
  readonly css?: string;
  readonly expect: Readonly<Record<string, Expectation>>;
}

const CSS = `
  .status { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
  .status.online { background-color: #27ae60; }
  .status.offline { background-color: #c0392b; }
  .status.warning { background-color: #f1c40f; }
  .pill { display: inline-block; width: 24px; height: 12px; }
  .pill.success { background-color: #27ae60; }
  .pill.error { background-color: #c0392b; }
  .tab { color: #555555; font-weight: 400; }
  .tab[aria-selected="true"] { color: #0645ad; }
  .tab.bold[aria-selected="true"] { font-weight: 700; }
  .tab.underlined[aria-selected="true"] { text-decoration-line: underline; }
  .nav-link { color: #555555; }
  .nav-link.active { color: #0645ad; }
  .f { border-top-style: solid; border-top-width: 1px; border-top-color: #888888; }
  .f[aria-invalid="true"] { border-top-color: #c0392b; }
  .f.thick[aria-invalid="true"] { border-top-width: 3px; }
  label.field { color: #333333; }
  label.field.required-label { color: #c0392b; }
  .badge { display: inline-block; padding: 2px 6px; color: #ffffff; }
  .badge.success { background-color: #27ae60; }
  .badge.error { background-color: #c0392b; }
  .badge.warning { background-color: #f1c40f; }
  .delta.positive { color: #27ae60; }
  .delta.negative { color: #c0392b; }
  .alert { padding: 4px; }
  .alert.error { background-color: #f8d7da; color: #721c24; }
  .alert.info { background-color: #d1ecf1; color: #0c5460; }
`;

const SCENARIOS: readonly Scenario[] = [
  // ---- presence ---------------------------------------------------------------------------
  {
    name: 'online / offline / warning dots: color is the only difference',
    category: 'presence',
    html: '<span id="on" class="status online"></span><span id="off" class="status offline"></span><span id="warn" class="status warning"></span>',
    expect: {
      '#on': { status: 'classified', state: 'online', confidence: 'high', cue: 'inner ✓' },
      '#off': { status: 'classified', state: 'offline', confidence: 'high', cue: 'inner ×' },
      '#warn': { status: 'classified', state: 'warning', confidence: 'high', cue: 'inner !' },
    },
  },
  {
    name: 'a dot whose size differs from its peers already has a second channel',
    category: 'accessible',
    html: '<span id="on" class="status online"></span><span id="off" class="status offline" style="width: 14px"></span>',
    expect: {
      '#on': { status: 'classified', state: 'online', confidence: 'high', cue: null },
      '#off': { status: 'classified', state: 'offline', confidence: 'high', cue: null },
    },
  },
  {
    name: 'a lone online dot (nothing to compare with) is color-only by construction',
    category: 'presence',
    html: '<span id="on" class="status online"></span>',
    expect: {
      '#on': { status: 'classified', state: 'online', confidence: 'high', cue: 'inner ✓' },
    },
  },
  {
    name: 'a bare "online" class on a plain span: one token is MEDIUM, no cue',
    category: 'ambiguous',
    html: '<span id="x" class="online">Alice</span><span id="y">Bob</span>',
    expect: { '#x': { status: 'classified', state: 'online', confidence: 'medium', cue: null } },
  },
  {
    name: 'dot with an icon child already has a non-color cue',
    category: 'accessible',
    html: '<span id="on" class="status online"><svg width="8" height="8"><circle r="3"/></svg></span><span class="status offline"></span>',
    expect: { '#on': { status: 'classified', state: 'online', confidence: 'high', cue: null } },
  },
  // ---- badges: success / error / warning ---------------------------------------------------
  {
    name: 'badges with identical geometry and no state word: ✓ and × are added',
    category: 'success',
    html: '<span id="a" class="badge success">Order 1</span><span id="b" class="badge error">Order 2</span>',
    expect: {
      '#a': { status: 'classified', state: 'success', confidence: 'high', cue: 'after ✓' },
      '#b': { status: 'classified', state: 'error', confidence: 'high', cue: 'after ×' },
    },
  },
  {
    name: 'badges whose text names the state need nothing (English)',
    category: 'accessible',
    html: '<span id="a" class="badge success">Success</span><span id="b" class="badge error">Error</span>',
    expect: {
      '#a': { status: 'classified', state: 'success', confidence: 'high', cue: null },
      '#b': { status: 'classified', state: 'error', confidence: 'high', cue: null },
    },
  },
  {
    name: 'badges whose text names the state need nothing (Russian)',
    category: 'accessible',
    html: '<span id="a" class="badge success">Успешно</span><span id="b" class="badge error">Ошибка</span>',
    expect: {
      '#a': { status: 'classified', state: 'success', confidence: 'high', cue: null },
      '#b': { status: 'classified', state: 'error', confidence: 'high', cue: null },
    },
  },
  {
    name: 'empty pills that differ only by fill',
    category: 'success',
    html: '<span id="a" class="pill success"></span><span id="b" class="pill error"></span>',
    expect: {
      '#a': { status: 'classified', state: 'success', confidence: 'high', cue: 'inner ✓' },
      '#b': { status: 'classified', state: 'error', confidence: 'high', cue: 'inner ×' },
    },
  },
  {
    name: 'a badge with a page-drawn ::after marker is left alone',
    category: 'accessible',
    html: '<span id="a" class="badge success" data-test-after="✓">Order 1</span><span id="b" class="badge error">Order 2</span>',
    expect: {
      '#a': { status: 'classified', state: 'success', confidence: 'high', cue: null },
      '#b': { status: 'classified', state: 'error', confidence: 'high', cue: 'after ×' },
    },
  },
  {
    name: 'a badge with a symbol already in its text',
    category: 'accessible',
    html: '<span id="a" class="badge success">✓ Order 1</span><span id="b" class="badge error">× Order 2</span>',
    expect: {
      '#a': { status: 'classified', state: 'success', confidence: 'high', cue: null },
      '#b': { status: 'classified', state: 'error', confidence: 'high', cue: null },
    },
  },
  {
    name: 'a badge whose peers differ in font weight: weight is a second channel',
    category: 'accessible',
    html: '<span id="a" class="badge success">Order 1</span><span id="b" class="badge error" style="font-weight: 700">Order 2</span>',
    expect: {
      '#a': { status: 'classified', state: 'success', confidence: 'high', cue: null },
      '#b': { status: 'classified', state: 'error', confidence: 'high', cue: null },
    },
  },
  {
    name: 'a warning badge next to a success one',
    category: 'warning',
    html: '<span id="a" class="badge success">Order 1</span><span id="b" class="badge warning">Order 2</span>',
    expect: {
      '#b': { status: 'classified', state: 'warning', confidence: 'high', cue: 'after !' },
    },
  },
  {
    name: 'a badge that already has a page SVG icon (M5 territory): no duplicate marker',
    category: 'accessible',
    html: '<span id="a" class="badge warning"><svg width="12" height="12" viewBox="0 0 12 12"><path d="M0 12L6 0L12 12Z"/></svg> Order 1</span><span id="b" class="badge success">Order 2</span>',
    expect: {
      '#a': { status: 'classified', state: 'warning', confidence: 'high', cue: null },
      // The success badge is told apart from the icon-bearing warning badge by the icon: not color-only.
      '#b': { status: 'classified', state: 'success', confidence: 'high', cue: null },
    },
  },
  {
    name: 'a badge with an <img alt> icon',
    category: 'accessible',
    html: '<span id="a" class="badge error"><img alt="error" src="data:,"> Order 1</span><span class="badge success">Order 2</span>',
    expect: { '#a': { status: 'classified', state: 'error', confidence: 'high', cue: null } },
  },
  {
    name: 'a badge with a role=img icon',
    category: 'accessible',
    html: '<span id="a" class="badge error"><span role="img" aria-label="error"></span> Order 1</span><span class="badge success">Order 2</span>',
    expect: { '#a': { status: 'classified', state: 'error', confidence: 'high', cue: null } },
  },
  {
    name: 'a badge with an icon-font glyph',
    category: 'accessible',
    html: '<span id="a" class="badge error"><i class="fa fa-times"></i> Order 1</span><span class="badge success">Order 2</span>',
    expect: { '#a': { status: 'classified', state: 'error', confidence: 'high', cue: null } },
  },
  // ---- alerts ------------------------------------------------------------------------------
  {
    name: 'role=alert + error class, no state word, differs from an info alert by color only',
    category: 'error',
    html: '<div id="e" role="alert" class="alert error">Something happened</div><div id="i" role="alert" class="alert info">Something else</div>',
    expect: {
      '#e': { status: 'classified', state: 'error', confidence: 'high', cue: 'after ×' },
      '#i': { status: 'classified', state: 'info', confidence: 'high', cue: 'after ℹ' },
    },
  },
  {
    name: 'role=alert with the word "Error" in it',
    category: 'accessible',
    html: '<div id="e" role="alert" class="alert error">Error: card declined</div><div class="alert info" role="status">Hello</div>',
    expect: { '#e': { status: 'classified', state: 'error', confidence: 'high', cue: null } },
  },
  {
    name: 'role=alert alone does not pick between error and warning',
    category: 'ambiguous',
    html: '<div id="a" role="alert">Something happened</div>',
    expect: { '#a': { status: 'unknown', cue: null } },
  },
  {
    name: 'a single status class on a paragraph is MEDIUM: reported, not applied',
    category: 'warning',
    html: '<p id="p" class="warning">Check your settings</p><p>Another paragraph</p>',
    expect: { '#p': { status: 'classified', state: 'warning', confidence: 'medium', cue: null } },
  },
  {
    name: 'visible text alone is LOW',
    category: 'error',
    html: '<span id="s">Failed</span>',
    expect: { '#s': { status: 'classified', state: 'error', confidence: 'low', cue: null } },
  },
  // ---- tabs and selection ------------------------------------------------------------------
  {
    name: 'selected tab differs by text color only: underline',
    category: 'selected',
    html: '<div role="tablist"><button id="t1" role="tab" class="tab" aria-selected="true">Home</button><button id="t2" role="tab" class="tab" aria-selected="false">Docs</button></div>',
    expect: {
      '#t1': { status: 'classified', state: 'selected', confidence: 'high', cue: 'underline' },
      '#t2': { status: 'classified', state: 'unselected', confidence: 'high', cue: null },
    },
  },
  {
    name: 'selected tab that is also bold',
    category: 'accessible',
    html: '<div role="tablist"><button id="t1" role="tab" class="tab bold" aria-selected="true">Home</button><button role="tab" class="tab bold" aria-selected="false">Docs</button></div>',
    expect: { '#t1': { status: 'classified', state: 'selected', confidence: 'high', cue: null } },
  },
  {
    name: 'selected tab that is already underlined',
    category: 'accessible',
    html: '<div role="tablist"><button id="t1" role="tab" class="tab underlined" aria-selected="true">Home</button><button role="tab" class="tab underlined" aria-selected="false">Docs</button></div>',
    expect: { '#t1': { status: 'classified', state: 'selected', confidence: 'high', cue: null } },
  },
  {
    name: 'aria-current link in a nav, color only: underline',
    category: 'active',
    html: '<nav><a id="n1" class="nav-link active" aria-current="page" href="#">Home</a><a id="n2" class="nav-link" href="#">About</a></nav>',
    expect: {
      '#n1': { status: 'classified', state: 'active', confidence: 'high', cue: 'underline' },
      '#n2': { status: 'unknown', cue: null },
    },
  },
  {
    name: 'an .active class on a nav link: class + nav context is HIGH',
    category: 'active',
    html: '<nav><a id="n1" class="nav-link active" href="#">Home</a><a id="n2" class="nav-link" href="#">About</a></nav>',
    expect: {
      '#n1': { status: 'classified', state: 'active', confidence: 'high', cue: 'underline' },
    },
  },
  {
    name: 'a tab with aria-selected but alone (no peers): cannot compare, so no cue',
    category: 'ambiguous',
    html: '<div role="tablist"><button id="t1" role="tab" class="tab" aria-selected="true">Home</button></div>',
    expect: { '#t1': { status: 'classified', state: 'selected', confidence: 'high', cue: null } },
  },
  // ---- form validity -----------------------------------------------------------------------
  {
    name: 'invalid field whose border differs only by color: dashed outline',
    category: 'invalid',
    html: '<input id="a" class="f" aria-invalid="true"><input id="b" class="f">',
    expect: {
      '#a': { status: 'classified', state: 'invalid', confidence: 'high', cue: 'outline:dashed' },
      '#b': { status: 'unknown', cue: null },
    },
  },
  {
    name: 'invalid field that is also thicker: already distinguishable',
    category: 'accessible',
    html: '<input id="a" class="f thick" aria-invalid="true"><input id="b" class="f thick">',
    expect: { '#a': { status: 'classified', state: 'invalid', confidence: 'high', cue: null } },
  },
  {
    name: 'a single invalid field has nothing to be compared with',
    category: 'ambiguous',
    html: '<input id="a" class="f" aria-invalid="true">',
    expect: { '#a': { status: 'classified', state: 'invalid', confidence: 'high', cue: null } },
  },
  {
    name: 'aria-invalid="false" says nothing',
    category: 'ambiguous',
    html: '<input id="a" class="f" aria-invalid="false"><input id="b" class="f">',
    expect: { '#a': { status: 'unknown', cue: null } },
  },
  // ---- required ----------------------------------------------------------------------------
  {
    name: 'required label drawn only in red: * is added to the label',
    category: 'required',
    html: '<label id="l1" class="field required-label" for="e">Email</label><input id="e" required><label id="l2" class="field" for="n">Name</label><input id="n">',
    expect: {
      '#l1': { status: 'classified', state: 'required', confidence: 'high', cue: 'after *' },
      '#e': { status: 'classified', state: 'required', confidence: 'high', cue: null },
      '#l2': { status: 'unknown', cue: null },
    },
  },
  {
    name: 'required label that already says *',
    category: 'accessible',
    html: '<label id="l1" class="field required-label" for="e">Email *</label><input id="e" required><label class="field" for="n">Name</label><input id="n">',
    expect: { '#l1': { status: 'classified', state: 'required', confidence: 'high', cue: null } },
  },
  {
    name: 'required label whose * is drawn by the page in ::after',
    category: 'accessible',
    html: '<label id="l1" class="field required-label" for="e" data-test-after="*">Email</label><input id="e" required><label class="field" for="n">Name</label><input id="n">',
    expect: { '#l1': { status: 'classified', state: 'required', confidence: 'high', cue: null } },
  },
  {
    name: 'required label that says "(required)"',
    category: 'accessible',
    html: '<label id="l1" class="field required-label" for="e">Email (required)</label><input id="e" required><label class="field" for="n">Name</label><input id="n">',
    expect: { '#l1': { status: 'classified', state: 'required', confidence: 'high', cue: null } },
  },
  {
    name: 'every label looks the same: color is not what says "required"',
    category: 'accessible',
    html: '<label id="l1" class="field" for="e">Email</label><input id="e" required><label class="field" for="n">Name</label><input id="n">',
    expect: { '#l1': { status: 'classified', state: 'required', confidence: 'high', cue: null } },
  },
  // ---- sign --------------------------------------------------------------------------------
  {
    name: 'values with no sign, positive and negative by color only',
    category: 'sign',
    html: '<span id="p" class="delta positive">12%</span><span id="n" class="delta negative">8%</span>',
    expect: {
      '#p': { status: 'classified', state: 'positive', confidence: 'high', cue: 'after +' },
      '#n': { status: 'classified', state: 'negative', confidence: 'high', cue: 'after −' },
    },
  },
  {
    name: 'values that carry their own sign (+12% / -8%)',
    category: 'accessible',
    html: '<span id="p" class="delta positive">+12%</span><span id="n" class="delta negative">-8%</span>',
    expect: {
      '#p': { status: 'classified', state: 'positive', confidence: 'high', cue: null },
      '#n': { status: 'classified', state: 'negative', confidence: 'high', cue: null },
    },
  },
  // ---- conflicts ---------------------------------------------------------------------------
  {
    name: 'class says success, ARIA says invalid',
    category: 'conflict',
    html: '<span id="x" class="badge success" aria-invalid="true">Order 1</span><span class="badge error">Order 2</span>',
    expect: { '#x': { status: 'conflict', cue: null } },
  },
  {
    name: 'class says online, another class says offline',
    category: 'conflict',
    html: '<span id="x" class="status online offline"></span>',
    expect: { '#x': { status: 'conflict', cue: null } },
  },
  {
    name: 'class says success, the text says Failed',
    category: 'conflict',
    html: '<span id="x" class="badge success">Failed</span>',
    expect: { '#x': { status: 'conflict', cue: null } },
  },
  {
    name: 'aria-selected=false but class says selected',
    category: 'conflict',
    html: '<button id="x" role="tab" class="tab selected" aria-selected="false">Home</button><button role="tab" class="tab" aria-selected="true">Docs</button>',
    expect: { '#x': { status: 'conflict', cue: null } },
  },
  // ---- false positives: color is not meaning -------------------------------------------------
  {
    name: 'red brand logo',
    category: 'false-positive',
    html: '<div id="x" class="logo" style="color: #c0392b; background-color: #ffffff">ACME</div>',
    expect: { '#x': { status: 'unknown', cue: null } },
  },
  {
    name: 'green decorative icon',
    category: 'false-positive',
    html: '<span id="x" class="deco" style="display:inline-block;width:12px;height:12px;background-color:#27ae60"></span>',
    expect: { '#x': { status: 'unknown', cue: null } },
  },
  {
    name: 'yellow star',
    category: 'false-positive',
    html: '<span id="x" class="star" style="color: #f1c40f">★</span>',
    expect: { '#x': { status: 'unknown', cue: null } },
  },
  {
    name: 'red sale price',
    category: 'false-positive',
    html: '<span id="x" class="price sale" style="color: #c0392b">$9.99</span><span class="price">$19.99</span>',
    expect: { '#x': { status: 'unknown', cue: null } },
  },
  {
    name: 'green navigation link',
    category: 'false-positive',
    html: '<nav><a id="x" class="nav-link green" style="color: #27ae60" href="#">Eco</a><a class="nav-link" href="#">Home</a></nav>',
    expect: { '#x': { status: 'unknown', cue: null } },
  },
  {
    name: 'a red delete button (btn-danger is a variant, not a state)',
    category: 'false-positive',
    html: '<button id="x" class="btn btn-danger">Delete</button><button class="btn btn-primary">Save</button>',
    expect: { '#x': { status: 'unknown', cue: null } },
  },
  {
    name: 'class names that merely contain state letters (terror, successor, errorless)',
    category: 'false-positive',
    html: '<p id="a" class="terror">x</p><p id="b" class="successor">y</p><p id="c" class="errorless">z</p>',
    expect: {
      '#a': { status: 'unknown', cue: null },
      '#b': { status: 'unknown', cue: null },
      '#c': { status: 'unknown', cue: null },
    },
  },
  {
    name: 'red text with no semantics at all',
    category: 'false-positive',
    html: '<p id="x" style="color: #ff0000">An ordinary red paragraph</p>',
    expect: { '#x': { status: 'unknown', cue: null } },
  },
  {
    name: 'prose that mentions an error is not an error state',
    category: 'false-positive',
    html: '<p id="x">We are sorry, an error occurred while loading the page for you today</p>',
    expect: { '#x': { status: 'unknown', cue: null } },
  },
  {
    name: '"No errors" is the opposite of an error',
    category: 'false-positive',
    html: '<span id="x">No errors</span>',
    expect: { '#x': { status: 'unknown', cue: null } },
  },
  {
    name: 'an untouched required input is required, not invalid',
    category: 'false-positive',
    html: '<input id="x" required class="f"><input class="f">',
    expect: { '#x': { status: 'classified', state: 'required', confidence: 'high', cue: null } },
  },
  {
    name: 'disabled controls keep their native semantics: no cue',
    category: 'accessible',
    html: '<button id="x" disabled class="btn">Save</button><button class="btn">Cancel</button>',
    expect: { '#x': { status: 'classified', state: 'disabled', confidence: 'high', cue: null } },
  },
];

afterEach(teardown);

function cueText(selector: string): string | null {
  const key = cueOf(selector);
  if (key === null) return null;
  return describeCue(key)?.replace(/^inner (.)$/, 'inner $1') ?? null;
}

describe('M6 semantic benchmark', () => {
  it('has the scenario mix the milestone asks for', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(30);
    expect(SCENARIOS.length).toBeLessThanOrEqual(60);
    const categories = new Set(SCENARIOS.map((s) => s.category));
    for (const category of [
      'success',
      'error',
      'warning',
      'selected',
      'invalid',
      'required',
      'presence',
      'sign',
      'ambiguous',
      'conflict',
      'accessible',
      'false-positive',
    ] as const) {
      expect(categories.has(category), category).toBe(true);
    }
  });

  for (const scenario of SCENARIOS) {
    it(`${scenario.category}: ${scenario.name}`, () => {
      const rig = mount(scenario.html, CSS);
      for (const [selector, expected] of Object.entries(scenario.expect)) {
        const inspection = rig.controller.inspectSemantics($(selector));
        expect(inspection.result.status, `${selector} status`).toBe(expected.status);
        if (inspection.result.status === 'classified') {
          if (expected.state)
            expect(inspection.result.state, `${selector} state`).toBe(expected.state);
          if (expected.confidence) {
            expect(inspection.result.confidence, `${selector} confidence`).toBe(
              expected.confidence,
            );
          }
        }
        const actual = cueText(selector);
        if (expected.cue === null) expect(actual, `${selector} cue`).toBeNull();
        else expect(actual, `${selector} cue`).toBe(expected.cue);
      }
    });
  }

  it('summary: pinned totals, no false positive, no cue without HIGH confidence', () => {
    let elements = 0;
    let classified = 0;
    let unknown = 0;
    let conflicts = 0;
    let autoCues = 0;
    let falsePositives = 0;
    for (const scenario of SCENARIOS) {
      const rig = mount(scenario.html, CSS);
      for (const selector of Object.keys(scenario.expect)) {
        const { result, decision } = rig.controller.inspectSemantics($(selector));
        elements += 1;
        if (result.status === 'classified') classified += 1;
        else if (result.status === 'unknown') unknown += 1;
        else conflicts += 1;
        const cued = cueOf(selector) !== null;
        if (cued) autoCues += 1;
        // A false positive: a cue where the evidence is not HIGH, or on a scenario that must stay untouched.
        if (cued && (result.status !== 'classified' || result.confidence !== 'high')) {
          falsePositives += 1;
        }
        if (scenario.category === 'false-positive' && (cued || decision.action === 'cue')) {
          falsePositives += 1;
        }
      }
      teardown();
    }
    expect({
      scenarios: SCENARIOS.length,
      elements,
      classified,
      unknown,
      conflicts,
      autoCues,
      falsePositives,
    }).toEqual({
      scenarios: 55,
      elements: 76,
      classified: 55,
      unknown: 17,
      conflicts: 4,
      autoCues: 19,
      falsePositives: 0,
    });
  });
});
