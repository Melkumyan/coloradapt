import { describe, expect, it } from 'vitest';
import { createBackgroundResolutionCache, readBorders, resolveColors } from '@core/analysis';

const getStyle = (el: Element) => getComputedStyle(el);

function setBody(html: string): void {
  document.body.innerHTML = html;
  document.body.removeAttribute('style');
}

describe('resolveColors', () => {
  it('flattens a semi-transparent foreground onto the resolved background', () => {
    setBody(
      '<p id="target" style="color: rgba(0,0,0,0.5); background: rgb(255,255,255);">hello</p>',
    );
    const target = document.getElementById('target')!;

    const result = resolveColors(target, getStyle, createBackgroundResolutionCache());

    expect(result?.backgroundKind).toBe('solid');
    expect(result?.colorPair.foreground).toMatchObject({ r: 0.5, g: 0.5, b: 0.5, alpha: 1 });
    expect(result?.colorPair.background).toMatchObject({ r: 1, g: 1, b: 1, alpha: 1 });
  });

  it('reports a gradient background as backgroundKind "gradient"', () => {
    setBody(
      '<p id="target" style="color: black; background-image: linear-gradient(red, blue);">hello</p>',
    );
    const target = document.getElementById('target')!;

    const result = resolveColors(target, getStyle, createBackgroundResolutionCache());

    expect(result?.backgroundKind).toBe('gradient');
  });
});

describe('readBorders', () => {
  it('returns undefined when no border is rendered', () => {
    setBody('<div id="target" style="border: none;"></div>');
    const target = document.getElementById('target')!;

    expect(readBorders(target, getStyle)).toBeUndefined();
  });

  it('reads a uniform border on all four sides', () => {
    setBody('<div id="target" style="border: 1px solid rgb(10,20,30);"></div>');
    const target = document.getElementById('target')!;

    const borders = readBorders(target, getStyle);

    expect(borders?.top).toMatchObject({ r: 10 / 255, g: 20 / 255, b: 30 / 255 });
    expect(borders?.right).toMatchObject({ r: 10 / 255, g: 20 / 255, b: 30 / 255 });
    expect(borders?.bottom).toMatchObject({ r: 10 / 255, g: 20 / 255, b: 30 / 255 });
    expect(borders?.left).toMatchObject({ r: 10 / 255, g: 20 / 255, b: 30 / 255 });
  });

  it('only reports the side that actually has a border', () => {
    setBody('<div id="target" style="border-bottom: 2px solid red;"></div>');
    const target = document.getElementById('target')!;

    const borders = readBorders(target, getStyle);

    expect(borders?.bottom).toMatchObject({ r: 1, g: 0, b: 0 });
    expect(borders?.top).toBeUndefined();
    expect(borders?.left).toBeUndefined();
    expect(borders?.right).toBeUndefined();
  });

  it('ignores a zero-width border even if a color is set', () => {
    setBody(
      '<div id="target" style="border-width: 0; border-style: solid; border-color: red;"></div>',
    );
    const target = document.getElementById('target')!;

    expect(readBorders(target, getStyle)).toBeUndefined();
  });
});
