import { describe, expect, it } from 'vitest';
import { analyzeDocument } from '@core/analysis';

/**
 * Benchmark-*style* tests: assert against the configured budget, not wall
 * clock. See docs/PERFORMANCE.md — a hard element/time budget, not a
 * best-effort scan, is the actual guarantee worth testing.
 */
describe('analyzeDocument performance budget', () => {
  it('never returns more than maxElements descriptors on a large DOM', () => {
    document.body.innerHTML = '';
    const container = document.createElement('div');
    for (let i = 0; i < 300; i += 1) {
      const p = document.createElement('p');
      p.textContent = `Row ${i}`;
      p.style.color = 'black';
      container.appendChild(p);
    }
    document.body.appendChild(container);

    const { elements, truncated } = analyzeDocument({
      root: container,
      maxElements: 50,
      now: () => 0,
    });

    expect(elements.length).toBeLessThanOrEqual(50);
    expect(truncated).toBe(true);
  });

  it('stops within the wall-clock budget regardless of element count', () => {
    document.body.innerHTML = '';
    const container = document.createElement('div');
    for (let i = 0; i < 300; i += 1) {
      const p = document.createElement('p');
      p.textContent = `Row ${i}`;
      container.appendChild(p);
    }
    document.body.appendChild(container);

    let calls = 0;
    // Simulate the clock advancing past the budget after a handful of elements.
    const now = () => {
      calls += 1;
      return calls > 5 ? 1000 : 0;
    };

    const { elements, truncated } = analyzeDocument({
      root: container,
      maxDurationMs: 50,
      now,
    });

    expect(truncated).toBe(true);
    expect(elements.length).toBeLessThan(300);
  });

  it('resolves a deeply nested, fully transparent ancestor chain without error', () => {
    document.body.innerHTML = '';
    let html = '<span id="deep">deep text</span>';
    for (let i = 0; i < 150; i += 1) {
      html = `<div style="background: transparent;">${html}</div>`;
    }
    const container = document.createElement('div');
    container.style.background = 'rgb(20, 40, 60)';
    container.innerHTML = html;
    document.body.appendChild(container);

    const { elements } = analyzeDocument({ root: container, now: () => 0 });

    const deep = elements.find((el) => el.tagName === 'span');
    expect(deep?.colorPair.background).toMatchObject({ r: 20 / 255, g: 40 / 255, b: 60 / 255 });
  });

  it('shares ancestor resolution cost across many siblings instead of recomputing per element', () => {
    document.body.innerHTML = '';
    const container = document.createElement('div');
    container.style.background = 'rgb(1,2,3)';
    for (let i = 0; i < 200; i += 1) {
      const span = document.createElement('span');
      span.textContent = `item ${i}`;
      container.appendChild(span);
    }
    document.body.appendChild(container);

    const { elements } = analyzeDocument({ root: container, now: () => 0 });

    expect(elements).toHaveLength(200);
    for (const el of elements) {
      expect(el.colorPair.background).toMatchObject({ r: 1 / 255, g: 2 / 255, b: 3 / 255 });
    }
  });
});
