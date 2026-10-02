import { describe, expect, it } from 'vitest';
import { isElementVisible } from '@core/analysis';

function setBody(html: string): Element {
  document.body.innerHTML = html;
  document.body.removeAttribute('style');
  const el = document.getElementById('target');
  if (!el) throw new Error('missing #target in fixture');
  return el;
}

describe('isElementVisible', () => {
  it('treats a plain element as visible', () => {
    const el = setBody('<p id="target">hello</p>');
    expect(isElementVisible(el, getComputedStyle(el))).toBe(true);
  });

  it('treats display: none as invisible', () => {
    const el = setBody('<p id="target" style="display: none;">hello</p>');
    expect(isElementVisible(el, getComputedStyle(el))).toBe(false);
  });

  it('treats visibility: hidden as invisible', () => {
    const el = setBody('<p id="target" style="visibility: hidden;">hello</p>');
    expect(isElementVisible(el, getComputedStyle(el))).toBe(false);
  });

  it('treats visibility: collapse as invisible', () => {
    const el = setBody('<p id="target" style="visibility: collapse;">hello</p>');
    expect(isElementVisible(el, getComputedStyle(el))).toBe(false);
  });

  it('treats opacity: 0 as invisible', () => {
    const el = setBody('<p id="target" style="opacity: 0;">hello</p>');
    expect(isElementVisible(el, getComputedStyle(el))).toBe(false);
  });

  it('does not use layout position to determine visibility (offscreen is still visible)', () => {
    const el = setBody('<p id="target" style="position: absolute; left: -9999px;">hello</p>');
    expect(isElementVisible(el, getComputedStyle(el))).toBe(true);
  });
});
