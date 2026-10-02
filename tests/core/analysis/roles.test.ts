import { describe, expect, it } from 'vitest';
import { classifyElementRole, isElementDisabled } from '@core/analysis';

function setBody(html: string): Element {
  document.body.innerHTML = html;
  const el = document.getElementById('target');
  if (!el) throw new Error('missing #target in fixture');
  return el;
}

describe('classifyElementRole', () => {
  it('classifies a button element', () => {
    expect(classifyElementRole(setBody('<button id="target">Go</button>'))).toBe('button');
  });

  it('classifies an input as a form control', () => {
    expect(classifyElementRole(setBody('<input id="target" />'))).toBe('form-control');
  });

  it('classifies an anchor as a link', () => {
    expect(classifyElementRole(setBody('<a id="target" href="#">link</a>'))).toBe('link');
  });
});

describe('isElementDisabled', () => {
  it('is false for a normal enabled button', () => {
    expect(isElementDisabled(setBody('<button id="target">Go</button>'))).toBe(false);
  });

  it('is true for a disabled button', () => {
    expect(isElementDisabled(setBody('<button id="target" disabled>Go</button>'))).toBe(true);
  });

  it('is true for a disabled input', () => {
    expect(isElementDisabled(setBody('<input id="target" disabled />'))).toBe(true);
  });

  it('is true for aria-disabled="true" on a non-form element', () => {
    expect(isElementDisabled(setBody('<div id="target" aria-disabled="true"></div>'))).toBe(true);
  });

  it('is false for aria-disabled="false"', () => {
    expect(isElementDisabled(setBody('<div id="target" aria-disabled="false"></div>'))).toBe(false);
  });
});
