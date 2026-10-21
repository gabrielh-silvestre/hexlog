import { describe, expect, it } from '@jest/globals';
import { escapeControls } from '../scripts/escape-controls.ts';

describe('escapeControls', () => {
  it.each([
    ['ESC', '\u001b', '\\u001b'],
    ['NUL', '\u0000', '\\u0000'],
    ['CR', '\r', '\\u000d'],
    ['DEL', '\u007f', '\\u007f'],
    ['CSI (C1)', '\u009b', '\\u009b'],
    ['OSC (C1)', '\u009d', '\\u009d'],
    ['RLO (bidi)', '‮', '\\u202e'],
    ['LRI (bidi)', '⁦', '\\u2066'],
    ['LRM (bidi)', '‎', '\\u200e'],
    ['ALM (bidi)', '؜', '\\u061c'],
  ])('should replace %s with its visible escape', (_name, control, escaped) => {
    expect(escapeControls(`a${control}b`)).toBe(`a${escaped}b`);
  });

  it('should leave LF, TAB, accents, emoji and BOM intact', () => {
    const text = 'linha\n\tDecisão — ação 😀 ﻿';

    expect(escapeControls(text)).toBe(text);
  });

  it('should keep already escaped text unchanged', () => {
    const once = escapeControls('x\u001b[31m\u009b‮y');

    expect(escapeControls(once)).toBe(once);
  });
});
