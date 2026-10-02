import { describe, expect, it } from 'vitest';
import { createBackgroundResolutionCache, resolveEffectiveForeground } from '@core/analysis';

const getStyle = (el: Element) => getComputedStyle(el);

function setBody(html: string): void {
  document.body.innerHTML = html;
  document.body.removeAttribute('style');
}

describe('resolveEffectiveForeground', () => {
  it('resolves a plain opaque color as-is', () => {
    setBody('<p id="target" style="color: rgb(10,20,30);">hello</p>');
    const target = document.getElementById('target')!;

    const result = resolveEffectiveForeground(target, getStyle, createBackgroundResolutionCache());

    expect(result).toMatchObject({ alpha: 1 });
  });

  it('inherits color from an ancestor via the browser-resolved computed style', () => {
    setBody(`
      <div style="color: rgb(200,0,0);">
        <p id="target">hello</p>
      </div>
    `);
    const target = document.getElementById('target')!;

    const result = resolveEffectiveForeground(target, getStyle, createBackgroundResolutionCache());

    expect(result?.r).toBeCloseTo(200 / 255, 2);
    expect(result?.alpha).toBe(1);
  });

  it("dims by the element's own opacity, flattened onto the white page", () => {
    setBody('<p id="target" style="color: rgb(0,0,0); opacity: 0.4;">hello</p>');
    const target = document.getElementById('target')!;

    const result = resolveEffectiveForeground(target, getStyle, createBackgroundResolutionCache());

    expect(result?.alpha).toBe(1);
    expect(result?.r).toBeCloseTo(0.6, 5); // .4 black + .6 white
  });

  it('multiplies color alpha by ancestor opacity (.5 * .5) exactly once', () => {
    setBody(`
      <div style="opacity: 0.5;">
        <p id="target" style="color: rgba(0,0,0,0.5);">hello</p>
      </div>
    `);
    const target = document.getElementById('target')!;

    const result = resolveEffectiveForeground(target, getStyle, createBackgroundResolutionCache());

    expect(result?.alpha).toBe(1);
    expect(result?.r).toBeCloseTo(0.75, 5); // .25 black + .75 white
  });

  it('returns null when color cannot be parsed', () => {
    const target = document.createElement('p');
    const brokenStyle = { color: 'not-a-color' } as unknown as CSSStyleDeclaration;

    const result = resolveEffectiveForeground(
      target,
      () => brokenStyle,
      createBackgroundResolutionCache(),
    );

    expect(result).toBeNull();
  });
});
