/**
 * Renders the public privacy and support pages (M13.R1) from their ONE canonical source, docs/store/PRIVACY_POLICY.md and
 * docs/store/SUPPORT.md, into public-site/{privacy,support}/index.html: pure static HTML and CSS, no script, no
 * request to any other host, no form, no cookie. The output is committed so the directory can be uploaded to any static
 * host as it is; `--check` fails when it differs from what the sources would render (tests/release/public-site.test.ts).
 *
 * Usage: node scripts/release/public-site.mjs [--check]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PAGES = [
  { slug: 'privacy', source: 'docs/store/PRIVACY_POLICY.md', title: 'ColorAdapt privacy policy' },
  { slug: 'support', source: 'docs/store/SUPPORT.md', title: 'ColorAdapt support' },
];

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Inline markdown: `code`, **bold**, _italic_, [text](url). Escapes everything else. */
function inline(text) {
  const codes = [];
  let s = esc(text.replace(/`([^`]+)`/g, (_m, c) => `@@${codes.push(c) - 1}@@`));
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:]|$)/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(((?:https:\/\/|\.\.\/)[^)\s]+)\)/g, (_m, t, u) =>
    u.startsWith('https:')
      ? `<a href="${u}" rel="noopener noreferrer">${t}</a>`
      : `<a href="${u}">${t}</a>`,
  );
  return s.replace(/@@(\d+)@@/g, (_m, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

export function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // { tag, items: string[] }
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list)
      out.push(
        `<${list.tag}>\n${list.items.map((i) => `<li>${inline(i)}</li>`).join('\n')}\n</${list.tag}>`,
      );
    list = null;
  };
  for (const line of lines) {
    let m;
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if ((m = /^(#{1,3}) (.*)$/.exec(line))) {
      flushPara();
      flushList();
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    } else if ((m = /^(?:[-*]|\d+\.) (.*)$/.exec(line))) {
      flushPara();
      const tag = /^\d/.test(line) ? 'ol' : 'ul';
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push(m[1]);
    } else if (/^\s+\S/.test(line) && list) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return out.join('\n');
}

const CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--muted:#4a4a4a;--link:#0b4f9c;--rule:#c9c9c9;--code:#f0f0f0}
@media (prefers-color-scheme:dark){:root{--bg:#16181c;--fg:#ececec;--muted:#b5b5b5;--link:#8ab8ff;--rule:#3a3d44;--code:#262a31}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:1rem/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header,main,footer{max-width:46rem;margin:0 auto;padding:0 1rem}
header{padding-top:1rem;border-bottom:1px solid var(--rule)}
nav ul{display:flex;flex-wrap:wrap;gap:1rem;margin:0 0 .75rem;padding:0;list-style:none}
a{color:var(--link);text-underline-offset:.15em}
a:focus-visible{outline:3px solid currentColor;outline-offset:2px}
h1{font-size:1.75rem;line-height:1.25;margin:1.5rem 0 .5rem}
h2{font-size:1.3rem;line-height:1.3;margin:2rem 0 .5rem}
h1,h2,p,li{overflow-wrap:anywhere}
li{margin:.25rem 0}
code{background:var(--code);padding:.1em .3em;border-radius:3px;font-size:.92em;overflow-wrap:anywhere}
footer{padding-top:1rem;padding-bottom:2rem;margin-top:2rem;border-top:1px solid var(--rule);color:var(--muted);font-size:.9rem}`;

export function renderPage(page, body, version) {
  const nav = PAGES.map(
    (p) =>
      `<li><a href="../${p.slug}/"${p.slug === page.slug ? ' aria-current="page"' : ''}>${p.slug === 'privacy' ? 'Privacy policy' : 'Support'}</a></li>`,
  ).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<title>${esc(page.title)}</title>
<style>${CSS}</style>
</head>
<body>
<header><nav aria-label="ColorAdapt"><ul>${nav}</ul></nav></header>
<main id="main">
${body}
</main>
<footer>ColorAdapt ${esc(version)}. This page is static: it has no scripts, trackers, cookies or forms.</footer>
</body>
</html>
`;
}

export function renderAll() {
  const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  return PAGES.map((page) => {
    let md = readFileSync(path.join(ROOT, page.source), 'utf8');
    // the two canonical documents refer to each other by file name; on the site they are pages
    md = md.replace('`PRIVACY_POLICY.md`', '[the privacy policy](../privacy/)');
    return {
      file: `public-site/${page.slug}/index.html`,
      html: renderPage(page, renderMarkdown(md), version),
    };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const { file, html } of renderAll()) {
    const abs = path.join(ROOT, file);
    if (check) {
      if (!existsSync(abs) || readFileSync(abs, 'utf8') !== html) {
        console.error(`STALE ${file}`);
        stale++;
      }
    } else {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, html);
      console.log(`wrote ${file}`);
    }
  }
  process.exit(stale ? 1 : 0);
}
