import type { SemanticFacts, ValidatorStatus } from '@core/semantic-ai';

/**
 * Curated semantic scenarios (docs/AI_SEMANTIC_ENGINE.md, "Benchmark"). Each one is the plain facts
 * of an element the deterministic layers left to a human, plus what is true of it:
 *
 * - `acceptable`: the labels a validator may ever accept for it (ground truth, written by a person
 *   who read the scenario, not derived from the validator). Empty means *no label* may be accepted:
 *   the facts do not settle the meaning, so any acceptance is a wrong one;
 * - `says` / `expect`: what a faithful model would say, and what the validator must make of it, by
 *   the documented acceptance rule (one strong fact, or two independent kinds of fact one of them
 *   medium; context and paint hints never count; a corroborated rival, a strong contradiction or a
 *   high-risk label without firm ground each stop an acceptance).
 */
export interface Scenario {
  readonly id: string;
  readonly family: string;
  readonly facts: SemanticFacts;
  readonly acceptable: readonly string[];
  /** What the faithful model says; `null` means it abstains (AMBIGUOUS / INSUFFICIENT_CONTEXT). */
  readonly says: string | null;
  readonly expect: ValidatorStatus;
}

const base: SemanticFacts = {
  task: 'CLASSIFY_UI_STATE',
  ruleId: 'CA-SEM-002',
  tag: 'li',
  role: null,
  controlType: null,
  aria: {},
  accessibleName: null,
  title: null,
  isField: false,
  interactive: false,
  hiddenFromAT: false,
  presentational: false,
  nearbyLabels: [],
  peers: [],
  colorRelation: 'color-only-difference',
  signals: [],
  classSegments: [],
  chart: null,
  image: null,
};

const sig = (
  source: string,
  value: string,
  supports: string,
  strength: 'strong' | 'medium' | 'weak' = 'medium',
) => ({ source, value, supports, strength });

const LANGS = ['en', 'ru'] as const;
type Lang = (typeof LANGS)[number];

/** Names a person would read next to the element, in both languages. */
const NAMES: Record<Lang, readonly string[]> = {
  en: ['Overview', 'Settings', 'Billing', 'Reports'],
  ru: ['Обзор', 'Настройки', 'Оплата', 'Отчёты'],
};
const HEADINGS: Record<Lang, string> = { en: 'Account sections', ru: 'Разделы аккаунта' };
const peers = (role: string | null) => [
  { tag: 'li', role, name: null, state: null },
  { tag: 'li', role, name: null, state: null },
];

export function buildSemanticScenarios(): Scenario[] {
  const out: Scenario[] = [];
  const add = (s: Scenario): void => {
    out.push(s);
  };

  // F1: aria-selected=true is a declared, strong fact.
  for (const role of ['tab', 'option', 'row', 'gridcell']) {
    for (const lang of LANGS) {
      for (const withClass of [false, true]) {
        const name = NAMES[lang][0] ?? '';
        add({
          id: `selected-aria-${role}-${lang}${withClass ? '-class' : ''}`,
          family: 'declared-selected',
          facts: {
            ...base,
            role,
            aria: { 'aria-selected': 'true' },
            accessibleName: name,
            nearbyLabels: [HEADINGS[lang]],
            peers: peers(role),
            signals: withClass ? [sig('class-token', 'active', 'active')] : [],
          },
          acceptable: ['selected', 'active'],
          says: 'selected',
          expect: 'ACCEPTED_ADVISORY',
        });
      }
    }
  }

  // F2: aria-selected=false.
  for (const role of ['tab', 'option', 'row']) {
    for (const lang of LANGS) {
      add({
        id: `unselected-aria-${role}-${lang}`,
        family: 'declared-unselected',
        facts: {
          ...base,
          role,
          aria: { 'aria-selected': 'false' },
          accessibleName: NAMES[lang][1] ?? '',
          peers: peers(role),
        },
        acceptable: ['unselected', 'inactive'],
        says: 'unselected',
        expect: 'ACCEPTED_ADVISORY',
      });
    }
  }

  // F3: a class word plus a control role: two independent kinds of fact.
  for (const role of ['tab', 'menuitem', 'option']) {
    for (const lang of LANGS) {
      for (const word of ['active', 'current']) {
        add({
          id: `active-class-role-${role}-${word}-${lang}`,
          family: 'class-and-role',
          facts: {
            ...base,
            role,
            accessibleName: NAMES[lang][2] ?? '',
            nearbyLabels: [HEADINGS[lang]],
            peers: peers(role),
            signals: [sig('class-token', word, 'active')],
          },
          acceptable: ['active', 'selected'],
          says: 'active',
          expect: 'ACCEPTED_ADVISORY',
        });
      }
    }
  }

  // F4: a class word alone, however plausible: not enough.
  const STATUS_WORDS: [string, string, string][] = [
    ['error', 'error', 'Payments'],
    ['danger', 'error', 'Sync'],
    ['failed', 'error', 'Upload'],
    ['warning', 'warning', 'Storage'],
    ['success', 'success', 'Backup'],
    ['info', 'info', 'Update'],
    ['positive', 'positive', 'Revenue'],
    ['negative', 'negative', 'Churn'],
    ['online', 'online', 'Agent'],
    ['offline', 'offline', 'Agent'],
  ];
  for (const [word, state, name] of STATUS_WORDS) {
    for (const lang of LANGS) {
      add({
        id: `class-only-${word}-${lang}`,
        family: 'class-only',
        facts: {
          ...base,
          task: 'CLASSIFY_STATUS_MEANING',
          tag: 'span',
          accessibleName: lang === 'en' ? name : null,
          nearbyLabels: [lang === 'en' ? name : 'Служба'],
          signals: [sig('class-token', `is-${word}`, state)],
        },
        acceptable: [],
        says: state === 'info' ? 'informational' : state,
        expect: 'UNRESOLVED',
      });
    }
  }

  // F5: a class word and the visible word agree: two independent kinds.
  const AGREE: [string, string, string, string, string][] = [
    ['error', 'error', 'error', 'ошибка', 'error'],
    ['warning', 'warning', 'warning', 'предупреждение', 'warning'],
    ['success', 'success', 'success', 'успешно', 'success'],
    ['info', 'info', 'info', 'информация', 'informational'],
  ];
  for (const [cls, state, textEn, textRu, label] of AGREE) {
    for (const lang of LANGS) {
      add({
        id: `class-and-text-${cls}-${lang}`,
        family: 'class-and-text',
        facts: {
          ...base,
          task: 'CLASSIFY_STATUS_MEANING',
          tag: 'span',
          signals: [
            sig('class-token', `is-${cls}`, state),
            sig('text-token', lang === 'en' ? textEn : textRu, state),
          ],
        },
        acceptable: [label],
        says: label,
        expect: 'ACCEPTED_ADVISORY',
      });
    }
  }

  // F6: the page says valid and also carries an error class: the declaration wins.
  for (const tag of ['div', 'li', 'span', 'td']) {
    for (const lang of LANGS) {
      add({
        id: `valid-with-error-class-${tag}-${lang}`,
        family: 'contradiction',
        facts: {
          ...base,
          tag,
          aria: { 'aria-invalid': 'false' },
          accessibleName: NAMES[lang][0] ?? '',
          signals: [sig('class-token', 'is-error', 'error')],
        },
        acceptable: [],
        says: 'error',
        expect: 'REJECTED',
      });
    }
  }

  // F7: a selected tab styled with a red class: it is selected.
  for (const role of ['tab', 'option', 'row']) {
    for (const lang of LANGS) {
      add({
        id: `selected-red-${role}-${lang}`,
        family: 'misleading-class',
        facts: {
          ...base,
          role,
          aria: { 'aria-selected': 'true' },
          accessibleName: NAMES[lang][3] ?? '',
          signals: [sig('class-token', 'is-error', 'error')],
        },
        acceptable: ['selected', 'active'],
        says: 'selected',
        expect: 'ACCEPTED_ADVISORY',
      });
    }
  }

  // F8: brand and decoration: nothing here names a state.
  const BRAND: [string, string | null, string[]][] = [
    ['div', null, ['Acme']],
    ['a', 'link', ['Logo']],
    ['span', null, ['Promo']],
    ['li', null, ['Featured']],
  ];
  for (const [tag, role, near] of BRAND) {
    for (const lang of LANGS) {
      add({
        id: `brand-${tag}-${lang}`,
        family: 'brand-ambiguity',
        facts: {
          ...base,
          tag,
          role,
          nearbyLabels: lang === 'en' ? near : ['Логотип'],
          signals: [sig('color', 'red', 'error', 'weak')],
        },
        acceptable: [],
        says: null,
        expect: 'UNRESOLVED',
      });
    }
  }

  // F9: a live region plus the word it says.
  for (const lang of LANGS) {
    for (const [role, word, label] of [
      ['status', lang === 'en' ? 'success' : 'успешно', 'success'],
      ['alert', lang === 'en' ? 'error' : 'ошибка', 'error'],
    ] as const) {
      for (const tag of ['div', 'p']) {
        add({
          id: `live-region-${role}-${tag}-${lang}`,
          family: 'role-and-text',
          facts: {
            ...base,
            task: 'CLASSIFY_STATUS_MEANING',
            tag,
            role,
            signals: [sig('role', role, role), sig('text-token', word, label)],
          },
          acceptable: [label],
          says: label,
          expect: 'ACCEPTED_ADVISORY',
        });
      }
    }
  }
  for (const lang of LANGS) {
    add({
      id: `status-role-only-${lang}`,
      family: 'role-only',
      facts: {
        ...base,
        task: 'CLASSIFY_STATUS_MEANING',
        tag: 'div',
        role: 'status',
        signals: [sig('role', 'status', 'status')],
      },
      acceptable: [],
      says: 'success',
      expect: 'UNRESOLVED',
    });
  }

  // F10: declared unavailable.
  for (const tag of ['button', 'a', 'li']) {
    for (const lang of LANGS) {
      add({
        id: `disabled-aria-${tag}-${lang}`,
        family: 'declared-unavailable',
        facts: {
          ...base,
          tag,
          interactive: true,
          aria: { 'aria-disabled': 'true' },
          accessibleName: NAMES[lang][1] ?? '',
        },
        acceptable: ['unavailable'],
        says: 'unavailable',
        expect: 'ACCEPTED_ADVISORY',
      });
    }
  }

  // F11: aria-current alone is one fact; with a class word it is two.
  for (const lang of LANGS) {
    for (const withClass of [false, true]) {
      for (const role of ['link', 'tab']) {
        add({
          id: `aria-current-${role}-${withClass ? 'class' : 'alone'}-${lang}`,
          family: 'aria-current',
          facts: {
            ...base,
            tag: 'a',
            role,
            aria: { 'aria-current': 'page' },
            accessibleName: NAMES[lang][0] ?? '',
            signals: withClass ? [sig('class-token', 'active', 'active')] : [],
          },
          acceptable: ['active'],
          says: 'active',
          // A tab adds its role to the declared current page; a plain link does not.
          expect: withClass || role === 'tab' ? 'ACCEPTED_ADVISORY' : 'UNRESOLVED',
        });
      }
    }
  }

  // F12: a nearby word that disagrees with the class never corroborates anything.
  for (const lang of LANGS) {
    for (const [cls, near] of [
      ['success', lang === 'en' ? 'Error' : 'Ошибка'],
      ['error', lang === 'en' ? 'Success' : 'Успешно'],
      ['warning', lang === 'en' ? 'Info' : 'Информация'],
    ] as const) {
      add({
        id: `disagreeing-neighbour-${cls}-${lang}`,
        family: 'misleading-neighbour',
        facts: {
          ...base,
          task: 'CLASSIFY_STATUS_MEANING',
          tag: 'span',
          nearbyLabels: [near],
          signals: [sig('class-token', `is-${cls}`, cls)],
        },
        acceptable: [],
        says: cls,
        expect: 'UNRESOLVED',
      });
    }
  }

  // F13: an icon button that names itself.
  const ICONS: [string, string, string][] = [
    ['close', 'Close', 'Закрыть'],
    ['menu', 'Menu', 'Меню'],
    ['search', 'Search', 'Поиск'],
    ['settings', 'Settings', 'Настройки'],
    ['delete', 'Delete', 'Удалить'],
    ['add', 'Add', 'Добавить'],
    ['edit', 'Edit', 'Редактировать'],
    ['download', 'Download', 'Скачать'],
    ['share', 'Share', 'Поделиться'],
    ['help', 'Help', 'Помощь'],
    ['home', 'Home', 'Главная'],
    ['refresh', 'Refresh', 'Обновить'],
    ['user', 'Profile', 'Профиль'],
    ['back', 'Back', 'Назад'],
  ];
  const icon = (label: string, over: Partial<SemanticFacts>): SemanticFacts => ({
    ...base,
    task: 'CLASSIFY_CONTROL_ICON',
    ruleId: 'CA-SVG-002',
    tag: 'button',
    interactive: true,
    colorRelation: 'not-compared',
    ...over,
  });
  for (const [label, en, ru] of ICONS) {
    for (const lang of LANGS) {
      add({
        id: `icon-named-${label}-${lang}`,
        family: 'icon-named',
        facts: icon(label, { accessibleName: lang === 'en' ? en : ru }),
        acceptable: [label],
        says: label,
        expect: 'ACCEPTED_ADVISORY',
      });
    }
  }

  // F14: a class name alone is a guess.
  for (const label of ['close', 'menu', 'search', 'settings', 'add', 'edit', 'home', 'refresh']) {
    add({
      id: `icon-class-only-${label}`,
      family: 'icon-class-only',
      facts: icon(label, { classSegments: ['icon', label] }),
      acceptable: [],
      says: label,
      expect: 'UNRESOLVED',
    });
  }

  // F15: the name outranks a class that says something else.
  for (const [named, cls] of [
    ['delete', 'close'],
    ['search', 'menu'],
    ['settings', 'home'],
  ] as const) {
    for (const lang of LANGS) {
      const entry = ICONS.find(([l]) => l === named);
      add({
        id: `icon-name-beats-class-${named}-${lang}`,
        family: 'icon-conflict',
        facts: icon(named, {
          accessibleName: lang === 'en' ? (entry?.[1] ?? null) : (entry?.[2] ?? null),
          classSegments: ['icon', cls],
        }),
        acceptable: [named],
        says: named,
        expect: 'ACCEPTED_ADVISORY',
      });
    }
  }

  // F16: an icon the author declared presentational is decoration; one merely hidden from assistive
  // technology is not known to be (a hidden chart is a problem, not decoration).
  for (const tag of ['svg', 'img', 'span']) {
    for (const lang of LANGS) {
      add({
        id: `icon-decorative-${tag}-${lang}`,
        family: 'icon-decorative',
        facts: icon('decorative', {
          tag,
          interactive: false,
          presentational: true,
          nearbyLabels: [NAMES[lang][0] ?? ''],
        }),
        acceptable: ['decorative'],
        says: 'decorative',
        expect: 'ACCEPTED_ADVISORY',
      });
      add({
        id: `icon-hidden-only-${tag}-${lang}`,
        family: 'icon-hidden',
        facts: icon('decorative', {
          tag,
          interactive: false,
          hiddenFromAT: true,
          nearbyLabels: [NAMES[lang][0] ?? ''],
        }),
        acceptable: [],
        says: 'decorative',
        expect: 'UNRESOLVED',
      });
    }
  }

  // F17: chart legends.
  const series = (n: number, colors: string[], titles: (string | null)[]) =>
    Array.from({ length: n }, (_, i) => ({
      title: titles[i] ?? null,
      colorName: colors[i] ?? 'gray',
    }));
  const chartFacts = (over: Partial<NonNullable<SemanticFacts['chart']>>): SemanticFacts => ({
    ...base,
    task: 'MAP_CHART_LABEL',
    ruleId: 'CA-CHART-002',
    tag: 'svg',
    colorRelation: 'not-compared',
    chart: {
      chartType: 'line',
      legendEntry: null,
      legendIndex: null,
      legendCount: 3,
      swatchColorName: null,
      series: series(3, ['red', 'green', 'blue'], [null, null, null]),
      ...over,
    },
  });
  const TITLES: Record<Lang, string[]> = {
    en: ['Revenue', 'Costs', 'Profit', 'Forecast'],
    ru: ['Выручка', 'Расходы', 'Прибыль', 'Прогноз'],
  };
  for (let k = 0; k < 4; k += 1) {
    for (const lang of LANGS) {
      add({
        id: `chart-title-${k + 1}-${lang}`,
        family: 'chart-title',
        facts: chartFacts({
          legendEntry: TITLES[lang][k] ?? null,
          legendIndex: k + 1,
          legendCount: 4,
          series: series(4, ['red', 'red', 'red', 'red'], TITLES[lang]),
        }),
        acceptable: [`series-${k + 1}`],
        says: `series-${k + 1}`,
        expect: 'ACCEPTED_ADVISORY',
      });
    }
  }
  for (let k = 0; k < 4; k += 1) {
    const colors = ['red', 'green', 'blue', 'orange'];
    add({
      id: `chart-unique-swatch-${k + 1}`,
      family: 'chart-swatch',
      facts: chartFacts({
        legendEntry: `Series ${String.fromCharCode(65 + k)}`,
        legendIndex: 4 - k,
        legendCount: 4,
        swatchColorName: colors[k] ?? null,
        series: series(4, colors, [null, null, null, null]),
      }),
      acceptable: [`series-${k + 1}`],
      says: `series-${k + 1}`,
      expect: 'ACCEPTED_ADVISORY',
    });
  }
  for (const n of [2, 3, 4, 5]) {
    // The last legend entry among series that share a color: the order breaks the tie.
    add({
      id: `chart-tie-order-${n}`,
      family: 'chart-tie',
      facts: chartFacts({
        legendEntry: 'Segment',
        legendIndex: n,
        legendCount: n,
        swatchColorName: 'blue',
        series: series(
          n,
          Array.from({ length: n }, () => 'blue'),
          [],
        ),
      }),
      acceptable: [`series-${n}`],
      says: `series-${n}`,
      expect: 'ACCEPTED_ADVISORY',
    });
  }
  for (const lang of LANGS) {
    for (const n of [2, 3]) {
      add({
        id: `chart-no-evidence-${n}-${lang}`,
        family: 'chart-ambiguous',
        facts: chartFacts({
          legendEntry: lang === 'en' ? 'Other' : 'Прочее',
          legendIndex: 1,
          legendCount: n + 2,
          swatchColorName: 'purple',
          series: series(n, ['red', 'green', 'blue'], [null, null, null]),
        }),
        acceptable: [],
        says: 'series-1',
        expect: 'UNRESOLVED',
      });
    }
  }
  for (const lang of LANGS) {
    for (const [entry, swatch, truth] of [
      [lang === 'en' ? 'Red' : 'Красный', 'blue', 2],
      [lang === 'en' ? 'Green' : 'Зелёный', 'orange', 3],
    ] as const) {
      add({
        id: `chart-misleading-legend-${truth}-${lang}`,
        family: 'chart-misleading',
        facts: chartFacts({
          legendEntry: entry,
          legendIndex: 1,
          legendCount: 3,
          swatchColorName: swatch,
          series: series(3, ['red', 'blue', 'orange'], ['Alpha', 'Beta', 'Gamma']),
        }),
        acceptable: [`series-${truth}`],
        says: `series-${truth}`,
        expect: 'ACCEPTED_ADVISORY',
      });
    }
  }

  // F18/F19: is it information or decoration? (graphics the audit cannot read)
  const graphic = (task: SemanticFacts['task'], ruleId: string, over: Partial<SemanticFacts>) => ({
    ...base,
    task,
    ruleId,
    tag: 'svg',
    colorRelation: 'not-compared' as const,
    ...over,
  });
  for (const lang of LANGS) {
    for (const tag of ['svg', 'img']) {
      add({
        id: `colour-decorative-${tag}-${lang}`,
        family: 'color-dependence',
        facts: graphic('ASSESS_COLOR_DEPENDENCE', 'CA-SVG-002', { tag, presentational: true }),
        acceptable: ['color-decorative'],
        says: 'color-decorative',
        expect: 'ACCEPTED_ADVISORY',
      });
      add({
        id: `colour-hidden-only-${tag}-${lang}`,
        family: 'color-dependence',
        facts: graphic('ASSESS_COLOR_DEPENDENCE', 'CA-SVG-002', { tag, hiddenFromAT: true }),
        acceptable: [],
        says: 'color-decorative',
        expect: 'UNRESOLVED',
      });
      add({
        id: `colour-named-alone-${tag}-${lang}`,
        family: 'color-dependence',
        facts: graphic('ASSESS_COLOR_DEPENDENCE', 'CA-SVG-002', {
          tag,
          accessibleName: lang === 'en' ? 'Status' : 'Статус',
          nearbyLabels: [NAMES[lang][0] ?? ''],
        }),
        acceptable: [],
        says: 'color-carries-meaning',
        expect: 'UNRESOLVED',
      });
      add({
        id: `colour-named-operated-${tag}-${lang}`,
        family: 'color-dependence',
        facts: graphic('ASSESS_COLOR_DEPENDENCE', 'CA-SVG-002', {
          tag,
          interactive: true,
          accessibleName: lang === 'en' ? 'Status' : 'Статус',
        }),
        acceptable: ['color-carries-meaning'],
        says: 'color-carries-meaning',
        expect: 'ACCEPTED_ADVISORY',
      });
    }
  }
  for (const rule of ['CA-CHART-004', 'CA-IMG-002', 'CA-CHART-003']) {
    for (const lang of LANGS) {
      add({
        id: `review-hidden-${rule}-${lang}`,
        family: 'manual-review-case',
        facts: graphic('ASSESS_MANUAL_REVIEW_CASE', rule, { tag: 'canvas', presentational: true }),
        acceptable: ['decorative'],
        says: 'decorative',
        expect: 'ACCEPTED_ADVISORY',
      });
      add({
        id: `review-hidden-only-${rule}-${lang}`,
        family: 'manual-review-case',
        facts: graphic('ASSESS_MANUAL_REVIEW_CASE', rule, { tag: 'canvas', hiddenFromAT: true }),
        acceptable: [],
        says: 'decorative',
        expect: 'UNRESOLVED',
      });
      add({
        id: `review-named-alone-${rule}-${lang}`,
        family: 'manual-review-case',
        facts: graphic('ASSESS_MANUAL_REVIEW_CASE', rule, {
          tag: 'canvas',
          accessibleName: lang === 'en' ? 'Sales by region' : 'Продажи по регионам',
        }),
        acceptable: [],
        says: 'carries-information',
        expect: 'UNRESOLVED',
      });
      add({
        id: `review-named-operated-${rule}-${lang}`,
        family: 'manual-review-case',
        facts: graphic('ASSESS_MANUAL_REVIEW_CASE', rule, {
          tag: 'canvas',
          interactive: true,
          accessibleName: lang === 'en' ? 'Sales by region' : 'Продажи по регионам',
        }),
        acceptable: ['carries-information'],
        says: 'carries-information',
        expect: 'ACCEPTED_ADVISORY',
      });
    }
  }

  // F20: nothing to go on, in every task.
  for (const task of [
    'CLASSIFY_UI_STATE',
    'CLASSIFY_STATUS_MEANING',
    'ASSESS_COLOR_DEPENDENCE',
    'CLASSIFY_CONTROL_ICON',
    'ASSESS_MANUAL_REVIEW_CASE',
  ] as const) {
    for (const lang of LANGS) {
      add({
        id: `insufficient-${task}-${lang}`,
        family: 'insufficient-context',
        facts: {
          ...base,
          task,
          ruleId:
            task === 'CLASSIFY_UI_STATE' || task === 'CLASSIFY_STATUS_MEANING'
              ? 'CA-SEM-002'
              : 'CA-SVG-002',
          nearbyLabels: [lang === 'en' ? 'Item' : 'Элемент'],
        },
        acceptable: [],
        says: null,
        expect: 'UNRESOLVED',
      });
    }
  }

  // F21: form fields. Their text is their value: only declarations count.
  for (const type of ['text', 'email', 'password', 'number']) {
    for (const lang of LANGS) {
      add({
        id: `field-class-only-${type}-${lang}`,
        family: 'form-field',
        facts: {
          ...base,
          task: 'CLASSIFY_STATUS_MEANING',
          tag: 'input',
          controlType: type,
          isField: true,
          interactive: true,
          accessibleName: 'private-value-that-must-not-count',
          signals: [
            sig('class-token', 'is-error', 'error'),
            sig('text-token', lang === 'en' ? 'error' : 'ошибка', 'error'),
          ],
        },
        // The only text a field has is its value; dropped, the class word stands alone.
        acceptable: [],
        says: 'error',
        expect: 'UNRESOLVED',
      });
    }
  }
  for (const type of ['text', 'email', 'password']) {
    add({
      id: `field-declared-invalid-${type}`,
      family: 'form-field',
      facts: {
        ...base,
        task: 'CLASSIFY_STATUS_MEANING',
        tag: 'input',
        controlType: type,
        isField: true,
        interactive: true,
        aria: { 'aria-invalid': 'true' },
      },
      acceptable: ['error'],
      says: 'error',
      expect: 'ACCEPTED_ADVISORY',
    });
  }
  return out;
}
