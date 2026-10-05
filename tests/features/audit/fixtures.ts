import { barChartSvg, lineChartSvg } from '../charts/engine';

/**
 * A page with something of every kind the audit looks at, and things it must leave alone
 * (docs/DEVELOPER_AUDIT.md). Inline SVG icons are not here: jsdom needs the fake CSS engine for
 * SVG paint, and that engine does not do HTML backgrounds (see `SVG_ICON_MARKUP`; the real
 * browser E2E page has both).
 */
export const REPRESENTATIVE_CSS = `
  body { background-color: #ffffff; color: #000000; }
  .low { color: #aaaaaa; background-color: #ffffff; }
  .cvd { color: #d62728; background-color: #2ca02c; }
  .fine { color: #000000; background-color: #ffffff; }
  .brand { color: #ffffff; background-color: #d62728; }
  .deco-a { display: inline-block; width: 20px; height: 20px; background-color: #d62728; }
  .deco-b { display: inline-block; width: 20px; height: 20px; background-color: #2ca02c; }
  .f { border-top-style: solid; border-top-width: 1px; border-top-color: #888888; }
  .f[aria-invalid="true"] { border-top-color: #c0392b; }
  .badge { display: inline-block; padding: 2px 6px; color: #ffffff; }
  .badge.success { background-color: #1a7f37; }
  .badge.error { background-color: #b42318; }
`;

export const REPRESENTATIVE_MARKUP = `
  <p id="low" class="low">Low contrast paragraph that is hard to read</p>
  <p id="cvd" class="cvd">Red on green: merges for deuteranopia</p>
  <p id="fine" class="fine">Perfectly readable paragraph</p>
  <p id="brand" class="brand">Brand banner text</p>
  <span id="deco-a" class="deco-a"></span><span id="deco-b" class="deco-b"></span>
  <input id="email-a" class="f" type="email" aria-invalid="true" aria-label="Email">
  <input id="email-b" class="f" type="email" aria-label="Email 2">
  <input id="email-c" class="f" type="email" aria-label="Email 3">
  <span id="ok-badge" class="badge success">✓ Passed</span>
  <span id="bad-badge" class="badge error">✗ Failed</span>
  ${lineChartSvg(['#d62728', '#2ca02c', '#ff7f0e']).replace('id="chart"', 'id="bad-chart"')}
  ${lineChartSvg(['#0072b2', '#d55e00', '#f0e442']).replace('id="chart"', 'id="good-chart"')}
  <canvas id="canvas-chart" class="sales-chart" width="300" height="150"></canvas>
  <canvas id="game" class="game-canvas" width="300" height="150"></canvas>
  <img id="raster-chart" src="/img/quarterly-chart.png" alt="Quarterly chart" width="300" height="200">
  <img id="photo" src="/img/team.jpg" alt="The team at the offsite" width="300" height="200">
  <img id="logo" src="/img/acme-logo.png" alt="Acme logo" width="80" height="32">
`;

const ICON = '<path d="M2 2 L22 2 L12 22 Z" fill="currentColor"/>';

/** Pale icons (poor contrast on white), one functional and one decorative; used with `svgEngine`. */
export const SVG_ICON_MARKUP = `
  <button id="icon-button" type="button"><svg id="icon" style="color: #dddddd" width="24" height="24" viewBox="0 0 24 24">${ICON}</svg></button>
  <svg id="deco-icon" aria-hidden="true" style="color: #dddddd" width="24" height="24" viewBox="0 0 24 24">${ICON}</svg>
  <svg id="dark-icon" style="color: #222222" width="24" height="24" viewBox="0 0 24 24">${ICON}</svg>
`;

export { barChartSvg, lineChartSvg };
