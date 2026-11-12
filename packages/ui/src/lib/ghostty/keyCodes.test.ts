// Adapted from T3 Code's libghostty-vt browser adapter tests (MIT, T3 Tools Inc.).
// See LICENSE-T3CODE in this directory.
import { describe, expect, test } from 'bun:test';

import { ghosttyConsumedMods, ghosttyKeyForCode, ghosttyUnshiftedCodepoint } from './keyCodes';

describe('ghosttyKeyForCode', () => {
  test('keeps the tail of the pinned Ghostty key enum in order', () => {
    expect(ghosttyKeyForCode('F25')).toBe(ghosttyKeyForCode('F24') + 1);
    expect(ghosttyKeyForCode('PrintScreen')).toBe(ghosttyKeyForCode('FnLock') + 1);
    expect(ghosttyKeyForCode('Pause')).toBe(ghosttyKeyForCode('ScrollLock') + 1);
    expect(ghosttyKeyForCode('Paste')).toBe(ghosttyKeyForCode('Cut') + 1);
  });
});

describe('ghosttyConsumedMods', () => {
  const shifted = { altKey: false, code: 'Digit2', ctrlKey: false, key: '@', metaKey: false, shiftKey: true };
  const option = { altKey: true, code: 'Digit4', ctrlKey: false, key: '$', metaKey: false, shiftKey: false };

  test('only consumes a lone Shift producing a character', () => {
    expect(ghosttyConsumedMods(shifted)).toBe(1);
    expect(ghosttyConsumedMods({ ...shifted, ctrlKey: true })).toBe(0);
    expect(ghosttyConsumedMods({ ...shifted, key: 'Tab' })).toBe(0);
    // Deliberate: Shift+Space collapses to Space so it still types one.
    expect(ghosttyConsumedMods({ ...shifted, key: ' ' })).toBe(1);
  });

  test('consumes macOS Option only when it composed an ASCII symbol', () => {
    expect(ghosttyConsumedMods(option, undefined, true)).toBe(1 << 2);
    expect(ghosttyConsumedMods({ ...option, code: 'Digit7', key: '\\', shiftKey: true }, undefined, true)).toBe(5);
    expect(ghosttyConsumedMods({ ...option, code: 'KeyL', key: '@' }, undefined, true)).toBe(1 << 2);
    expect(ghosttyConsumedMods(option, undefined, false)).toBe(0);
    expect(ghosttyConsumedMods({ ...option, ctrlKey: true }, undefined, true)).toBe(0);
    expect(ghosttyConsumedMods({ ...option, code: 'KeyB', key: '∫' }, undefined, true)).toBe(0);
    // Russian - PC types Latin letters with Option; they stay Meta chords.
    const russian = new Map([['KeyA', 'ф']]);
    expect(ghosttyConsumedMods({ ...option, code: 'KeyA', key: 'd' }, russian, true)).toBe(0);
    // The active layout decides what the key types on its own.
    const dollarOnDigit4 = new Map([['Digit4', '$']]);
    expect(ghosttyConsumedMods(option, dollarOnDigit4, true)).toBe(0);
  });
});

describe('ghosttyUnshiftedCodepoint', () => {
  test('provides the logical base character for Kitty keyboard encoding', () => {
    expect(ghosttyUnshiftedCodepoint({ code: 'KeyC', key: 'c', shiftKey: false })).toBe(
      'c'.codePointAt(0),
    );
    expect(ghosttyUnshiftedCodepoint({ code: 'KeyC', key: 'C', shiftKey: true })).toBe(
      'c'.codePointAt(0),
    );
    expect(ghosttyUnshiftedCodepoint({ code: 'Digit1', key: '!', shiftKey: true })).toBe(
      '1'.codePointAt(0),
    );
    expect(ghosttyUnshiftedCodepoint({ code: 'Slash', key: '?', shiftKey: true })).toBe(
      '/'.codePointAt(0),
    );
    expect(ghosttyUnshiftedCodepoint({ code: 'Digit1', key: '&', shiftKey: false })).toBe(
      '&'.codePointAt(0),
    );
    expect(ghosttyUnshiftedCodepoint({ code: 'Enter', key: 'Enter', shiftKey: false })).toBe(0);
  });

  test('reports unknown instead of the shifted character without layout data', () => {
    expect(ghosttyUnshiftedCodepoint({ code: 'Digit7', key: '/', shiftKey: true })).toBe(0);
    expect(ghosttyUnshiftedCodepoint({ code: 'KeyD', key: 'Д', shiftKey: true })).toBe(
      'д'.codePointAt(0),
    );
  });

  test('prefers the active browser layout over US physical key positions', () => {
    const layoutMap = new Map([
      ['Digit1', '&'],
      ['KeyC', 'j'],
    ]);
    expect(ghosttyUnshiftedCodepoint({ code: 'Digit1', key: '1', shiftKey: true }, layoutMap)).toBe(
      '&'.codePointAt(0),
    );
    expect(ghosttyUnshiftedCodepoint({ code: 'KeyC', key: 'J', shiftKey: true }, layoutMap)).toBe(
      'j'.codePointAt(0),
    );
  });
});
