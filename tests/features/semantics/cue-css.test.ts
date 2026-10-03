import { describe, expect, it } from 'vitest';
import {
  CUE_ATTRIBUTE,
  CUE_FONT_FAMILY,
  cueKey,
  cueRule,
  cueSheet,
  renderedGlyph,
} from '@features/semantics';

describe('M6 cue keys and CSS', () => {
  it('a key says everything about how the cue looks', () => {
    expect(cueKey({ type: 'suffix-symbol', placement: 'after', glyph: '✓' })).toBe('after:2713');
    expect(cueKey({ type: 'prefix-symbol', placement: 'before', glyph: '×' })).toBe('before:d7');
    expect(
      cueKey({ type: 'marker', placement: 'inner', glyph: '!' }, { tone: 'd', size: 12 }),
    ).toBe('inner:21:d:12');
    expect(cueKey({ type: 'border-style', placement: 'outline', outline: 'dashed' })).toBe(
      'outline:dashed',
    );
    expect(cueKey({ type: 'underline', placement: 'underline' })).toBe('underline');
  });

  it('every glyph rule carries an empty alternative text, a fallback, and cannot be hit', () => {
    const keys = ['before:d7', 'inner:21:l:10', 'after:2139', 'after:2713', 'inner:2713:l:10'];
    for (const key of keys) {
      const rule = cueRule(key);
      expect(rule).toContain(`[${CUE_ATTRIBUTE}="${key}"]`);
      // Text (`"\d7 "`) or a shape (`""`), each twice: with and without the empty alternative text.
      expect(rule).toMatch(
        /content:("\\[0-9a-f]+ "|"") !important;content:("\\[0-9a-f]+ "|"") \/ "" !important;/,
      );
      expect(rule).toContain('pointer-events:none');
      expect(rule).toContain('user-select:none');
    }
  });

  it('colors are never invented: a glyph follows currentColor, a dot glyph is black, white or current', () => {
    expect(cueRule('after:2713')).not.toMatch(/#[0-9a-f]{3,6}|rgb/i);
    expect(cueRule('inner:2713:l:10')).toContain('color:#fff');
    expect(cueRule('inner:2713:d:10')).toContain('color:#000');
    expect(cueRule('inner:2713:c:10')).toContain('color:currentColor');
    expect(cueRule('outline:dashed')).toContain('outline-color:currentColor');
    expect(cueRule('underline')).not.toMatch(/#[0-9a-f]{3,6}|rgb/i);
  });

  it('a dot keeps its baseline and its size: overflow clipped, glyph scaled to the dot', () => {
    expect(cueRule('inner:2713:l:10')).toContain('overflow:hidden !important');
    expect(cueRule('inner:d7:l:10')).toContain('font:700 7px/1');
    expect(cueRule('inner:d7:l:20')).toContain('font:700 14px/1');
  });

  it('no glyph is trusted to a font that may not have it', () => {
    // The check mark and the info sign are drawn: a shape, and an ASCII "i" in a ring.
    expect(renderedGlyph('✓')).toBe('');
    expect(renderedGlyph('ℹ')).toBe('i');
    for (const glyph of ['×', '!', '*', '+', '−', '↑', '↓'])
      expect(renderedGlyph(glyph)).toBe(glyph);
    expect(cueRule('after:2713')).toContain('clip-path:polygon(');
    expect(cueRule('after:2713')).not.toContain('\\2713');
    expect(cueRule('after:2139')).toContain('content:"\\69 "');
    // Text glyphs never inherit the page's (possibly icon) font, and never make a line taller.
    expect(cueRule('after:d7')).toContain(`font-family:${CUE_FONT_FAMILY} !important`);
    expect(cueRule('after:d7')).toContain('line-height:0 !important');
    expect(cueRule('inner:d7:l:10')).toContain(CUE_FONT_FAMILY);
  });

  it('a drawn shape stays visible in forced-colors mode', () => {
    for (const key of ['after:2713', 'before:2713', 'inner:2713:l:10']) {
      const rule = cueRule(key);
      expect(rule).toContain('@media (forced-colors:active)');
      expect(rule).toContain('forced-color-adjust:none !important');
      expect(rule).toContain('background-color:CanvasText !important');
    }
    expect(cueRule('after:d7')).not.toContain('forced-colors');
  });

  it('an outline pattern gives the focus ring back while focused', () => {
    const rule = cueRule('outline:dashed');
    expect(rule).toContain('outline-style:dashed');
    expect(rule).toContain(':focus-visible{outline:auto');
    expect(cueRule('outline:double')).toContain('outline-width:3px');
  });

  it('unknown keys produce nothing, and the sheet is deterministic', () => {
    expect(cueRule('nonsense')).toBe('');
    expect(cueRule('after:')).toBe('');
    expect(cueSheet([])).toBeNull();
    expect(cueSheet(['nonsense'])).toBeNull();
    expect(cueSheet(['underline', 'after:2713'])).toBe(
      cueSheet(['after:2713', 'underline', 'underline']),
    );
  });
});
