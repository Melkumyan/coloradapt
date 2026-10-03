import { describe, expect, it } from 'vitest';
import { verifySvgPaints } from '@core/svg';
import { parseColor } from '@core/color';
import { createFakeEngine, mount } from './fake-engine';

const expected = parseColor('#a1150b')!;

function verify(markup: string): boolean {
  mount(markup);
  const engine = createFakeEngine(document);
  return verifySvgPaints(document.querySelector('svg')!, expected, engine.getStyle);
}

describe('verifySvgPaints (does every visible paint read the planned color?)', () => {
  it('true when every painted fill and stroke is the planned color', () => {
    expect(verify('<svg><path fill="#a1150b"/><circle fill="rgb(161, 21, 11)"/></svg>')).toBe(true);
    expect(verify('<svg><path fill="none" stroke="#a1150b" stroke-width="2"/></svg>')).toBe(true);
  });

  it('false when a shape still has another color (a local declaration out-ranked the rule)', () => {
    expect(verify('<svg><path fill="#a1150b"/><path fill="#c0392b"/></svg>')).toBe(false);
  });

  it('false when a stroke still has another color', () => {
    expect(verify('<svg><path fill="#a1150b" stroke="#c0392b" stroke-width="2"/></svg>')).toBe(
      false,
    );
  });

  it('invisible paints are not judged', () => {
    expect(
      verify(
        '<svg><path fill="#a1150b"/><path fill="#c0392b" fill-opacity="0"/><path fill="none" stroke="#c0392b" stroke-width="0"/></svg>',
      ),
    ).toBe(true);
  });

  it('false for a translucent paint (an alpha is not the planned opaque color)', () => {
    expect(verify('<svg><path fill="rgba(161, 21, 11, 0.5)"/></svg>')).toBe(false);
  });

  it('false when a paint server appears', () => {
    expect(verify('<svg><defs><linearGradient id="g"/></defs><path fill="url(#g)"/></svg>')).toBe(
      false,
    );
  });

  it('false when the unit is over budget (a partial scan proves nothing)', () => {
    const many = Array.from({ length: 40 }, () => '<rect fill="#a1150b"/>').join('');
    expect(verify(`<svg>${many}</svg>`)).toBe(false);
  });

  it('true for an SVG with nothing painted', () => {
    expect(verify('<svg><path fill="none"/></svg>')).toBe(true);
  });
});
