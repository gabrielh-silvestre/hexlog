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
    ['RLO (bidi)', '\u202e', '\\u202e'],
    ['LRI (bidi)', '\u2066', '\\u2066'],
    ['LRM (bidi)', '\u200e', '\\u200e'],
    ['ALM (bidi)', '\u061c', '\\u061c'],
    ['LS (line separator)', '\u2028', '\\u2028'],
    ['PS (paragraph separator)', '\u2029', '\\u2029'],
    ['tag character at the start of the range', '\u{E0000}', '\\udb40\\udc00'],
    ['tag character in the range', '\u{E0041}', '\\udb40\\udc41'],
    ['tag character at the end of the range', '\u{E007F}', '\\udb40\\udc7f'],
  ])('should replace %s with its visible escape', (_name, control, escaped) => {
    expect(escapeControls(`a${control}b`)).toBe(`a${escaped}b`);
  });

  it('should leave LF, TAB, accents, emoji, ZWJ, BOM and the code point after the tag range intact', () => {
    const text = 'linha\n\tDecisão — ação 😀 👨\u200d👩 \ufeff \u{E0080}';

    expect(escapeControls(text)).toBe(text);
  });

  it('should keep a JSON string with a tag character and a line separator parseable back to the original', () => {
    const value = { text: 'a\u{E0041}b\u2028c' };

    const parsed: unknown = JSON.parse(escapeControls(JSON.stringify(value)));

    expect(parsed).toEqual(value);
  });

  it('should keep already escaped text unchanged', () => {
    const once = escapeControls('x\u001b[31m\u009b\u202ey');

    expect(escapeControls(once)).toBe(once);
  });
});
