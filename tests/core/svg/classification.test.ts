import { beforeEach, describe, expect, it } from 'vitest';
import { classifySvgElement, isOutermostSvg, outermostSvg } from '@core/svg';
import { mount } from './fake-engine';

const find = (selector: string): Element => {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`${selector} missing`);
  return element;
};

describe('SVG element roles', () => {
  beforeEach(() => {
    mount(`
    <div id="html"></div>
    <svg id="outer">
      <g id="g">
        <path id="path"/><circle id="circle"/><ellipse id="ellipse"/><rect id="rect"/>
        <line id="line"/><polyline id="polyline"/><polygon id="polygon"/>
        <text id="text">t<tspan id="tspan">x</tspan></text>
        <use id="use" href="#g"/>
        <svg id="inner"></svg>
        <foreignObject id="fo"><span id="span">x</span></foreignObject>
      </g>
      <defs id="defs"><symbol id="symbol"></symbol></defs>
    </svg>`);
  });

  it.each([
    ['#outer', 'icon'],
    ['#inner', 'container'],
    ['#g', 'container'],
    ['#path', 'shape'],
    ['#circle', 'shape'],
    ['#ellipse', 'shape'],
    ['#rect', 'shape'],
    ['#line', 'shape'],
    ['#polyline', 'shape'],
    ['#polygon', 'shape'],
    ['#text', 'text'],
    ['#tspan', 'text'],
    ['#use', 'use-instance'],
    ['#defs', 'unknown'],
    ['#symbol', 'unknown'],
    ['#fo', 'unknown'],
    ['#html', 'unknown'],
    ['#span', 'unknown'],
  ] as const)('%s is %s', (selector, role) => {
    expect(classifySvgElement(find(selector))).toBe(role);
  });
});

describe('outermost svg', () => {
  beforeEach(() => {
    mount(`
    <svg id="outer"><g><path id="deep"/><svg id="inner"><circle id="c"/></svg>
      <foreignObject><div id="html-in-svg"><svg id="svg-in-html"></svg></div></foreignObject>
    </g></svg>
    <p id="p"></p>`);
  });

  it('finds the unit an inner element belongs to', () => {
    expect(outermostSvg(find('#deep'))).toBe(find('#outer'));
    expect(outermostSvg(find('#c'))).toBe(find('#outer'));
    expect(outermostSvg(find('#inner'))).toBe(find('#outer'));
    expect(outermostSvg(find('#outer'))).toBe(find('#outer'));
  });

  it('is null outside any inline SVG, and HTML inside foreignObject is not part of the SVG', () => {
    expect(outermostSvg(find('#p'))).toBeNull();
    expect(outermostSvg(find('#html-in-svg'))).toBeNull();
  });

  it('an <svg> inside HTML inside an <svg> is its own unit', () => {
    expect(outermostSvg(find('#svg-in-html'))).toBe(find('#svg-in-html'));
    expect(isOutermostSvg(find('#svg-in-html'))).toBe(true);
  });

  it('only a non-nested <svg> is a unit root', () => {
    expect(isOutermostSvg(find('#outer'))).toBe(true);
    expect(isOutermostSvg(find('#inner'))).toBe(false);
    expect(isOutermostSvg(find('#deep'))).toBe(false);
    expect(isOutermostSvg(find('#p'))).toBe(false);
  });
});
