import { describe, expect, it } from 'vitest';
import { createContentController } from '@features/page-analysis';
import { DEFAULT_USER_SETTINGS } from '@domain/models';

function setUpLowContrastPage(): void {
  document.body.innerHTML = `
    <p style="color: rgb(250,250,250); background-color: rgb(255,255,255);">Hard to read</p>
  `;
}

describe('createContentController', () => {
  it('analyze() reports detected conflicts without touching the stylesheet', () => {
    setUpLowContrastPage();
    const controller = createContentController(document);

    const result = controller.analyze('https://example.com', DEFAULT_USER_SETTINGS);

    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
    expect(controller.getLastAnalysis()).toEqual(result);
  });

  it('analyze() excludes gradient-background elements from conflicts but counts them as unresolved', () => {
    document.body.innerHTML = `
      <p style="color: rgb(240,240,240); background-image: linear-gradient(red, blue);">
        Could be anything
      </p>
    `;
    const controller = createContentController(document);

    const result = controller.analyze('https://example.com', DEFAULT_USER_SETTINGS);

    expect(result.conflicts).toHaveLength(0);
    expect(result.unresolvedCount).toBe(1);
  });

  it('enableAdaptation() applies a stylesheet, disableAdaptation() restores the original state', () => {
    setUpLowContrastPage();
    const controller = createContentController(document);

    const { adaptation } = controller.enableAdaptation(
      'https://example.com',
      DEFAULT_USER_SETTINGS,
    );
    expect(adaptation.changes.length).toBeGreaterThan(0);
    expect(document.getElementById('coloradapt-stylesheet')).not.toBeNull();

    controller.disableAdaptation();
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
  });
});
