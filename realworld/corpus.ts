/**
 * The M10 real-world corpus: live, public, unauthenticated pages. A page is never logged into, never filled in
 * and never submitted; nothing about a visitor (cookies, tokens, accounts) is stored. The live web drifts, so
 * the corpus is an *address list plus measured properties*, not a snapshot: every run records when it ran,
 * the browser version, the HTTP-visible outcome and the properties it measured (see `corpus-run.spec.ts`).
 * A page that does not load in a run is reported as such and never silently dropped.
 *
 * `tech` is what the page is *believed* to be built with (a hint used to check the corpus is diverse); what
 * the harness actually measured (frameworks, Shadow DOM, SVG, canvas, ...) is stored with each run's result.
 */

export type Category =
  | 'news'
  | 'ecommerce'
  | 'documentation'
  | 'saas'
  | 'government'
  | 'education'
  | 'finance'
  | 'forum'
  | 'blog'
  | 'dashboard'
  | 'landing'
  | 'portfolio'
  | 'accessibility';

export type Script = 'latin' | 'cyrillic' | 'rtl' | 'cjk';

export type Rendering = 'static' | 'server-rendered' | 'spa' | 'hybrid';

export interface CorpusEntry {
  readonly id: string;
  readonly category: Category;
  readonly url: string;
  readonly rendering: Rendering;
  /** Believed technologies: react, vue, angular, nextjs, svelte, cssinjs, svg-heavy, canvas, image-heavy, ... */
  readonly tech: readonly string[];
  readonly script: Script;
  /** Always false in this corpus (see the header); kept explicit because the classification requires it. */
  readonly authRequired: false;
}

type Row = [
  id: string,
  category: Category,
  url: string,
  rendering: Rendering,
  tech: string,
  script?: Script,
];

const ROWS: Row[] = [
  // --- news / media -------------------------------------------------------------------------------------
  ['news-bbc', 'news', 'https://www.bbc.com/news', 'hybrid', 'react,nextjs,image-heavy'],
  ['news-npr', 'news', 'https://www.npr.org/', 'server-rendered', 'image-heavy'],
  [
    'news-guardian',
    'news',
    'https://www.theguardian.com/international',
    'server-rendered',
    'react,image-heavy',
  ],
  ['news-apnews', 'news', 'https://apnews.com/', 'hybrid', 'image-heavy'],
  ['news-aljazeera', 'news', 'https://www.aljazeera.com/', 'hybrid', 'image-heavy'],
  ['news-lemonde', 'news', 'https://www.lemonde.fr/', 'server-rendered', 'image-heavy'],
  ['news-spiegel', 'news', 'https://www.spiegel.de/', 'server-rendered', 'image-heavy'],
  ['news-lenta', 'news', 'https://lenta.ru/', 'server-rendered', 'image-heavy', 'cyrillic'],
  ['news-meduza', 'news', 'https://meduza.io/', 'spa', 'react,spa', 'cyrillic'],
  ['news-nhk', 'news', 'https://www3.nhk.or.jp/nhkworld/en/', 'hybrid', 'image-heavy'],
  ['news-asahi', 'news', 'https://www.asahi.com/', 'server-rendered', 'image-heavy', 'cjk'],
  ['news-aljazeera-ar', 'news', 'https://www.aljazeera.net/', 'hybrid', 'image-heavy', 'rtl'],
  ['news-ynet', 'news', 'https://www.ynet.co.il/', 'server-rendered', 'image-heavy', 'rtl'],
  ['news-theverge', 'news', 'https://www.theverge.com/', 'hybrid', 'nextjs,react,image-heavy'],
  ['news-arstechnica', 'news', 'https://arstechnica.com/', 'server-rendered', 'image-heavy'],
  ['news-xinhua', 'news', 'https://www.news.cn/', 'server-rendered', 'image-heavy', 'cjk'],
  // --- e-commerce ---------------------------------------------------------------------------------------
  ['shop-ebay', 'ecommerce', 'https://www.ebay.com/', 'server-rendered', 'image-heavy'],
  ['shop-etsy', 'ecommerce', 'https://www.etsy.com/', 'server-rendered', 'image-heavy'],
  ['shop-walmart', 'ecommerce', 'https://www.walmart.com/', 'hybrid', 'react,nextjs,image-heavy'],
  ['shop-target', 'ecommerce', 'https://www.target.com/', 'spa', 'react,image-heavy'],
  ['shop-bestbuy', 'ecommerce', 'https://www.bestbuy.com/', 'hybrid', 'react,image-heavy'],
  ['shop-ikea', 'ecommerce', 'https://www.ikea.com/us/en/', 'hybrid', 'image-heavy'],
  ['shop-allbirds', 'ecommerce', 'https://www.allbirds.com/', 'server-rendered', 'image-heavy'],
  ['shop-gymshark', 'ecommerce', 'https://www.gymshark.com/', 'hybrid', 'react,image-heavy'],
  ['shop-books-toscrape', 'ecommerce', 'https://books.toscrape.com/', 'static', 'static'],
  [
    'shop-webscraper-static',
    'ecommerce',
    'https://webscraper.io/test-sites/e-commerce/static',
    'static',
    'static',
  ],
  [
    'shop-webscraper-more',
    'ecommerce',
    'https://webscraper.io/test-sites/e-commerce/more',
    'server-rendered',
    'jquery',
  ],
  [
    'shop-rozetka',
    'ecommerce',
    'https://rozetka.com.ua/',
    'spa',
    'angular,image-heavy',
    'cyrillic',
  ],
  [
    'shop-rakuten',
    'ecommerce',
    'https://www.rakuten.co.jp/',
    'server-rendered',
    'image-heavy',
    'cjk',
  ],
  ['shop-aliexpress', 'ecommerce', 'https://www.aliexpress.com/', 'spa', 'react,image-heavy'],
  ['shop-newegg', 'ecommerce', 'https://www.newegg.com/', 'server-rendered', 'image-heavy'],
  ['shop-zappos', 'ecommerce', 'https://www.zappos.com/', 'hybrid', 'react,image-heavy'],
  // --- documentation ------------------------------------------------------------------------------------
  [
    'doc-mdn',
    'documentation',
    'https://developer.mozilla.org/en-US/docs/Web/CSS',
    'hybrid',
    'react,webcomponents',
  ],
  ['doc-python', 'documentation', 'https://docs.python.org/3/', 'static', 'static'],
  ['doc-react', 'documentation', 'https://react.dev/learn', 'hybrid', 'react,nextjs,cssinjs'],
  [
    'doc-vue',
    'documentation',
    'https://vuejs.org/guide/introduction.html',
    'hybrid',
    'vue,cssvars',
  ],
  ['doc-angular', 'documentation', 'https://angular.dev/overview', 'spa', 'angular,webcomponents'],
  ['doc-nextjs', 'documentation', 'https://nextjs.org/docs', 'hybrid', 'react,nextjs,cssvars'],
  ['doc-k8s', 'documentation', 'https://kubernetes.io/docs/home/', 'static', 'static'],
  ['doc-github', 'documentation', 'https://docs.github.com/en', 'hybrid', 'react,nextjs'],
  [
    'doc-msft-learn',
    'documentation',
    'https://learn.microsoft.com/en-us/',
    'server-rendered',
    'cssvars',
  ],
  [
    'doc-tailwind',
    'documentation',
    'https://tailwindcss.com/docs/installation',
    'hybrid',
    'react,nextjs,cssvars',
  ],
  ['doc-go', 'documentation', 'https://go.dev/doc/', 'static', 'static'],
  ['doc-rust-book', 'documentation', 'https://doc.rust-lang.org/book/', 'static', 'static'],
  ['doc-postgres', 'documentation', 'https://www.postgresql.org/docs/current/', 'static', 'static'],
  ['doc-nodejs', 'documentation', 'https://nodejs.org/en/docs', 'hybrid', 'react,nextjs'],
  ['doc-webdev', 'documentation', 'https://web.dev/learn', 'server-rendered', 'webcomponents'],
  [
    'doc-wikipedia-en',
    'documentation',
    'https://en.wikipedia.org/wiki/Color_blindness',
    'server-rendered',
    'image-heavy',
  ],
  [
    'doc-wikipedia-ru',
    'documentation',
    'https://ru.wikipedia.org/wiki/Дальтонизм',
    'server-rendered',
    'image-heavy',
    'cyrillic',
  ],
  [
    'doc-wikipedia-ar',
    'documentation',
    'https://ar.wikipedia.org/wiki/عمى_الألوان',
    'server-rendered',
    'image-heavy',
    'rtl',
  ],
  [
    'doc-wikipedia-ja',
    'documentation',
    'https://ja.wikipedia.org/wiki/色覚異常',
    'server-rendered',
    'image-heavy',
    'cjk',
  ],
  [
    'doc-wikipedia-he',
    'documentation',
    'https://he.wikipedia.org/wiki/עיוורון_צבעים',
    'server-rendered',
    'image-heavy',
    'rtl',
  ],
  [
    'doc-man7',
    'documentation',
    'https://man7.org/linux/man-pages/man2/open.2.html',
    'static',
    'static',
  ],
  [
    'doc-svelte',
    'documentation',
    'https://svelte.dev/docs/svelte/overview',
    'hybrid',
    'svelte,cssvars',
  ],
  // --- SaaS / web apps ----------------------------------------------------------------------------------
  [
    'saas-github-repo',
    'saas',
    'https://github.com/microsoft/vscode',
    'hybrid',
    'react,webcomponents,cssvars',
  ],
  ['saas-gitlab', 'saas', 'https://gitlab.com/explore', 'spa', 'vue,spa'],
  ['saas-excalidraw', 'saas', 'https://excalidraw.com/', 'spa', 'react,spa,canvas,svg-heavy'],
  ['saas-todomvc-react', 'saas', 'https://todomvc.com/examples/react/dist/', 'spa', 'react,spa'],
  ['saas-todomvc-vue', 'saas', 'https://todomvc.com/examples/vue/dist/', 'spa', 'vue,spa'],
  [
    'saas-todomvc-angular',
    'saas',
    'https://todomvc.com/examples/angular/dist/browser/',
    'spa',
    'angular,spa',
  ],
  [
    'saas-todomvc-vanilla',
    'saas',
    'https://todomvc.com/examples/javascript-es6/dist/',
    'spa',
    'spa',
  ],
  ['saas-squoosh', 'saas', 'https://squoosh.app/', 'spa', 'spa,canvas,webcomponents'],
  ['saas-diagrams', 'saas', 'https://app.diagrams.net/', 'spa', 'spa,svg-heavy,canvas'],
  ['saas-codepen', 'saas', 'https://codepen.io/trending', 'hybrid', 'react,image-heavy'],
  ['saas-jsfiddle', 'saas', 'https://jsfiddle.net/', 'spa', 'spa'],
  ['saas-regex101', 'saas', 'https://regex101.com/', 'spa', 'react,spa'],
  ['saas-photopea', 'saas', 'https://www.photopea.com/', 'spa', 'spa,canvas'],
  ['saas-netlify-app', 'saas', 'https://www.netlify.com/', 'hybrid', 'nextjs,react'],
  ['saas-vercel', 'saas', 'https://vercel.com/', 'hybrid', 'nextjs,react,cssvars'],
  // --- government / public services ---------------------------------------------------------------------
  ['gov-usa', 'government', 'https://www.usa.gov/', 'server-rendered', 'static'],
  ['gov-uk', 'government', 'https://www.gov.uk/', 'server-rendered', 'static'],
  ['gov-canada', 'government', 'https://www.canada.ca/en.html', 'server-rendered', 'static'],
  ['gov-australia', 'government', 'https://www.australia.gov.au/', 'server-rendered', 'static'],
  [
    'gov-europa',
    'government',
    'https://european-union.europa.eu/index_en',
    'server-rendered',
    'static',
  ],
  ['gov-irs', 'government', 'https://www.irs.gov/', 'server-rendered', 'static'],
  ['gov-nih', 'government', 'https://www.nih.gov/', 'server-rendered', 'image-heavy'],
  ['gov-nasa', 'government', 'https://www.nasa.gov/', 'server-rendered', 'image-heavy'],
  [
    'gov-bund',
    'government',
    'https://www.bundesregierung.de/breg-de',
    'server-rendered',
    'image-heavy',
  ],
  [
    'gov-service-public',
    'government',
    'https://www.service-public.fr/',
    'server-rendered',
    'static',
  ],
  ['gov-gosuslugi', 'government', 'https://www.gosuslugi.ru/', 'spa', 'spa,vue', 'cyrillic'],
  [
    'gov-digital-jp',
    'government',
    'https://www.digital.go.jp/',
    'server-rendered',
    'image-heavy',
    'cjk',
  ],
  ['gov-israel', 'government', 'https://www.gov.il/he', 'spa', 'angular,spa', 'rtl'],
  ['gov-data', 'government', 'https://data.gov/', 'server-rendered', 'static'],
  ['gov-cdc', 'government', 'https://www.cdc.gov/', 'server-rendered', 'static'],
  ['gov-login-gov', 'government', 'https://www.login.gov/', 'static', 'static'],
  // --- education ----------------------------------------------------------------------------------------
  ['edu-mit', 'education', 'https://www.mit.edu/', 'server-rendered', 'image-heavy'],
  ['edu-stanford', 'education', 'https://www.stanford.edu/', 'server-rendered', 'image-heavy'],
  ['edu-harvard', 'education', 'https://www.harvard.edu/', 'server-rendered', 'image-heavy'],
  ['edu-oxford', 'education', 'https://www.ox.ac.uk/', 'server-rendered', 'image-heavy'],
  ['edu-khan', 'education', 'https://www.khanacademy.org/', 'spa', 'react,spa,cssinjs'],
  ['edu-coursera', 'education', 'https://www.coursera.org/', 'spa', 'react,spa,cssinjs'],
  ['edu-edx', 'education', 'https://www.edx.org/', 'hybrid', 'nextjs,react'],
  ['edu-msu', 'education', 'https://www.msu.ru/', 'server-rendered', 'image-heavy', 'cyrillic'],
  [
    'edu-utokyo',
    'education',
    'https://www.u-tokyo.ac.jp/en/',
    'server-rendered',
    'image-heavy',
    'cjk',
  ],
  ['edu-pku', 'education', 'https://english.pku.edu.cn/', 'server-rendered', 'image-heavy', 'cjk'],
  ['edu-openstax', 'education', 'https://openstax.org/', 'hybrid', 'react,image-heavy'],
  ['edu-codecademy', 'education', 'https://www.codecademy.com/', 'hybrid', 'react,cssinjs'],
  [
    'edu-hebrew-univ',
    'education',
    'https://new.huji.ac.il/',
    'server-rendered',
    'image-heavy',
    'rtl',
  ],
  ['edu-freecodecamp', 'education', 'https://www.freecodecamp.org/', 'hybrid', 'react,gatsby'],
  // --- finance ------------------------------------------------------------------------------------------
  ['fin-yahoo', 'finance', 'https://finance.yahoo.com/', 'hybrid', 'react,svg-heavy'],
  ['fin-marketwatch', 'finance', 'https://www.marketwatch.com/', 'server-rendered', 'image-heavy'],
  ['fin-nasdaq', 'finance', 'https://www.nasdaq.com/', 'spa', 'react,svg-heavy'],
  [
    'fin-tradingview',
    'finance',
    'https://www.tradingview.com/markets/',
    'spa',
    'react,canvas,svg-heavy',
  ],
  [
    'fin-coinmarketcap',
    'finance',
    'https://coinmarketcap.com/',
    'hybrid',
    'nextjs,react,svg-heavy',
  ],
  ['fin-ecb', 'finance', 'https://www.ecb.europa.eu/', 'server-rendered', 'static'],
  ['fin-fed', 'finance', 'https://www.federalreserve.gov/', 'server-rendered', 'static'],
  ['fin-sec', 'finance', 'https://www.sec.gov/', 'server-rendered', 'static'],
  ['fin-wise', 'finance', 'https://wise.com/', 'hybrid', 'nextjs,react'],
  ['fin-revolut', 'finance', 'https://www.revolut.com/', 'hybrid', 'nextjs,react'],
  ['fin-moex', 'finance', 'https://www.moex.com/', 'server-rendered', 'static', 'cyrillic'],
  ['fin-jpx', 'finance', 'https://www.jpx.co.jp/english/', 'server-rendered', 'static', 'cjk'],
  ['fin-tase', 'finance', 'https://www.tase.co.il/he', 'spa', 'angular,spa', 'rtl'],
  [
    'fin-investopedia',
    'finance',
    'https://www.investopedia.com/',
    'server-rendered',
    'image-heavy',
  ],
  // --- forums / community -------------------------------------------------------------------------------
  ['forum-hn', 'forum', 'https://news.ycombinator.com/', 'static', 'static'],
  [
    'forum-old-reddit',
    'forum',
    'https://old.reddit.com/r/accessibility/',
    'server-rendered',
    'static',
  ],
  [
    'forum-stackoverflow',
    'forum',
    'https://stackoverflow.com/questions',
    'server-rendered',
    'jquery',
  ],
  ['forum-lobsters', 'forum', 'https://lobste.rs/', 'static', 'static'],
  ['forum-discourse-meta', 'forum', 'https://meta.discourse.org/', 'spa', 'ember,spa'],
  ['forum-phpbb', 'forum', 'https://www.phpbb.com/community/', 'server-rendered', 'static'],
  ['forum-slashdot', 'forum', 'https://slashdot.org/', 'server-rendered', 'jquery'],
  ['forum-devto', 'forum', 'https://dev.to/', 'hybrid', 'image-heavy'],
  ['forum-pikabu', 'forum', 'https://pikabu.ru/', 'server-rendered', 'image-heavy', 'cyrillic'],
  ['forum-discuss-python', 'forum', 'https://discuss.python.org/', 'spa', 'ember,spa'],
  ['forum-4pda', 'forum', 'https://4pda.to/forum/', 'server-rendered', 'static', 'cyrillic'],
  ['forum-cloudflare', 'forum', 'https://community.cloudflare.com/', 'spa', 'ember,spa'],
  // --- blogs --------------------------------------------------------------------------------------------
  ['blog-mozilla', 'blog', 'https://blog.mozilla.org/en/', 'server-rendered', 'image-heavy'],
  ['blog-csstricks', 'blog', 'https://css-tricks.com/', 'server-rendered', 'image-heavy'],
  ['blog-smashing', 'blog', 'https://www.smashingmagazine.com/', 'server-rendered', 'image-heavy'],
  ['blog-overreacted', 'blog', 'https://overreacted.io/', 'hybrid', 'react,gatsby'],
  ['blog-joel', 'blog', 'https://www.joelonsoftware.com/', 'server-rendered', 'static'],
  ['blog-paulgraham', 'blog', 'https://paulgraham.com/articles.html', 'static', 'static'],
  ['blog-daringfireball', 'blog', 'https://daringfireball.net/', 'server-rendered', 'static'],
  ['blog-habr', 'blog', 'https://habr.com/ru/articles/', 'spa', 'vue,spa', 'cyrillic'],
  ['blog-cloudflare', 'blog', 'https://blog.cloudflare.com/', 'server-rendered', 'image-heavy'],
  ['blog-jvns', 'blog', 'https://jvns.ca/', 'static', 'static'],
  ['blog-danluu', 'blog', 'https://danluu.com/', 'static', 'static'],
  [
    'blog-joshwcomeau',
    'blog',
    'https://www.joshwcomeau.com/',
    'hybrid',
    'nextjs,react,cssinjs,cssvars',
  ],
  ['blog-qiita', 'blog', 'https://qiita.com/', 'server-rendered', 'image-heavy', 'cjk'],
  ['blog-zhihu-zhuanlan', 'blog', 'https://zhuanlan.zhihu.com/', 'spa', 'react,spa', 'cjk'],
  // --- dashboards / data --------------------------------------------------------------------------------
  [
    'dash-grafana-play',
    'dashboard',
    'https://play.grafana.org/',
    'spa',
    'react,spa,canvas,svg-heavy',
  ],
  [
    'dash-githubstatus',
    'dashboard',
    'https://www.githubstatus.com/',
    'server-rendered',
    'svg-heavy',
  ],
  [
    'dash-cloudflarestatus',
    'dashboard',
    'https://www.cloudflarestatus.com/',
    'server-rendered',
    'svg-heavy',
  ],
  ['dash-owid', 'dashboard', 'https://ourworldindata.org/', 'hybrid', 'react,svg-heavy'],
  [
    'dash-owid-chart',
    'dashboard',
    'https://ourworldindata.org/grapher/life-expectancy',
    'hybrid',
    'react,svg-heavy',
  ],
  [
    'dash-gapminder',
    'dashboard',
    'https://www.gapminder.org/tools/',
    'spa',
    'spa,svg-heavy,canvas',
  ],
  [
    'dash-worldometer',
    'dashboard',
    'https://www.worldometers.info/world-population/',
    'server-rendered',
    'jquery,canvas',
  ],
  ['dash-nullschool', 'dashboard', 'https://earth.nullschool.net/', 'spa', 'spa,canvas'],
  ['dash-observable', 'dashboard', 'https://observablehq.com/@d3/gallery', 'hybrid', 'svg-heavy'],
  ['dash-d3-gallery', 'dashboard', 'https://d3js.org/', 'static', 'svg-heavy'],
  [
    'dash-chartjs-samples',
    'dashboard',
    'https://www.chartjs.org/docs/latest/samples/bar/vertical.html',
    'spa',
    'vue,canvas',
  ],
  ['dash-highcharts-demo', 'dashboard', 'https://www.highcharts.com/demo', 'hybrid', 'svg-heavy'],
  [
    'dash-echarts-examples',
    'dashboard',
    'https://echarts.apache.org/examples/en/index.html',
    'spa',
    'vue,canvas,svg-heavy',
  ],
  ['dash-statuspage-openai', 'dashboard', 'https://status.openai.com/', 'spa', 'react,svg-heavy'],
  [
    'dash-metabase-demo',
    'dashboard',
    'https://www.metabase.com/',
    'hybrid',
    'nextjs,react,svg-heavy',
  ],
  // --- landing pages ------------------------------------------------------------------------------------
  ['land-apple', 'landing', 'https://www.apple.com/', 'server-rendered', 'image-heavy'],
  ['land-stripe', 'landing', 'https://stripe.com/', 'hybrid', 'react,svg-heavy,cssvars'],
  ['land-linear', 'landing', 'https://linear.app/', 'hybrid', 'nextjs,react,cssvars'],
  ['land-notion', 'landing', 'https://www.notion.com/', 'hybrid', 'nextjs,react,image-heavy'],
  ['land-framer', 'landing', 'https://www.framer.com/', 'hybrid', 'react,image-heavy'],
  ['land-mailchimp', 'landing', 'https://mailchimp.com/', 'server-rendered', 'image-heavy'],
  ['land-airbnb', 'landing', 'https://www.airbnb.com/', 'spa', 'react,image-heavy,cssinjs'],
  ['land-tesla', 'landing', 'https://www.tesla.com/', 'hybrid', 'image-heavy'],
  ['land-mozilla-org', 'landing', 'https://www.mozilla.org/en-US/', 'server-rendered', 'static'],
  ['land-firefox', 'landing', 'https://www.firefox.com/en-US/', 'server-rendered', 'static'],
  ['land-spotify', 'landing', 'https://www.spotify.com/us/', 'hybrid', 'react,image-heavy'],
  ['land-figma', 'landing', 'https://www.figma.com/', 'hybrid', 'react,image-heavy'],
  ['land-example', 'landing', 'https://example.com/', 'static', 'static'],
  ['land-info-cern', 'landing', 'http://info.cern.ch/', 'static', 'static'],
  ['land-motherfucking', 'landing', 'https://motherfuckingwebsite.com/', 'static', 'static'],
  // --- portfolios ---------------------------------------------------------------------------------------
  ['port-brittany', 'portfolio', 'https://brittanychiang.com/', 'spa', 'react,spa'],
  ['port-bruno-simon', 'portfolio', 'https://bruno-simon.com/', 'spa', 'spa,canvas,webgl'],
  ['port-leerob', 'portfolio', 'https://leerob.com/', 'hybrid', 'nextjs,react'],
  ['port-cassie', 'portfolio', 'https://www.cassie.codes/', 'hybrid', 'nextjs,react'],
  ['port-dribbble', 'portfolio', 'https://dribbble.com/shots', 'server-rendered', 'image-heavy'],
  ['port-behance', 'portfolio', 'https://www.behance.net/', 'spa', 'react,image-heavy'],
  ['port-awwwards', 'portfolio', 'https://www.awwwards.com/', 'server-rendered', 'image-heavy'],
  ['port-lynnandtonic', 'portfolio', 'https://lynnandtonic.com/', 'static', 'image-heavy'],
  ['port-robbowen', 'portfolio', 'https://robbowen.digital/', 'static', 'image-heavy'],
  [
    'port-codepen-profile',
    'portfolio',
    'https://codepen.io/team/codepen/',
    'hybrid',
    'react,image-heavy',
  ],
  // --- accessibility-oriented ---------------------------------------------------------------------------
  ['a11y-w3c-wai', 'accessibility', 'https://www.w3.org/WAI/', 'server-rendered', 'static'],
  ['a11y-webaim', 'accessibility', 'https://webaim.org/', 'server-rendered', 'static'],
  ['a11y-a11yproject', 'accessibility', 'https://www.a11yproject.com/', 'static', 'static'],
  [
    'a11y-govuk-ds',
    'accessibility',
    'https://design-system.service.gov.uk/',
    'server-rendered',
    'static',
  ],
  [
    'a11y-apg',
    'accessibility',
    'https://www.w3.org/WAI/ARIA/apg/patterns/',
    'server-rendered',
    'static',
  ],
  ['a11y-deque', 'accessibility', 'https://www.deque.com/', 'server-rendered', 'image-heavy'],
  [
    'a11y-colorbrewer',
    'accessibility',
    'https://colorbrewer2.org/',
    'spa',
    'jquery,svg-heavy,canvas',
  ],
  ['a11y-contrast-ratio', 'accessibility', 'https://contrast-ratio.com/', 'static', 'static'],
  [
    'a11y-inclusive-components',
    'accessibility',
    'https://inclusive-components.design/',
    'static',
    'static',
  ],
  ['a11y-digital-gov', 'accessibility', 'https://accessibility.digital.gov/', 'static', 'static'],
  ['a11y-whocanuse', 'accessibility', 'https://www.whocanuse.com/', 'spa', 'react,spa'],
  [
    'a11y-bbc',
    'accessibility',
    'https://www.bbc.co.uk/accessibility/',
    'server-rendered',
    'static',
  ],
  [
    'a11y-apple',
    'accessibility',
    'https://www.apple.com/accessibility/',
    'server-rendered',
    'image-heavy',
  ],
  [
    'a11y-colorblind-org',
    'accessibility',
    'https://www.colourblindawareness.org/',
    'server-rendered',
    'image-heavy',
  ],
];

export const CORPUS: readonly CorpusEntry[] = ROWS.map(
  ([id, category, url, rendering, tech, script]) => ({
    id,
    category,
    url,
    rendering,
    tech: tech.split(','),
    script: script ?? 'latin',
    authRequired: false,
  }),
);

/** The corpus entries of a category. */
export const byCategory = (category: Category): CorpusEntry[] =>
  CORPUS.filter((entry) => entry.category === category);
