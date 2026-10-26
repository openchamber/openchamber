import { describe, expect, test } from 'bun:test';

import { areFontAdvancesMonospace, canvasFontFamilies, quoteFontFamilyName } from './fonts';

describe('canvasFontFamilies', () => {
  test('quotes names the canvas shorthand would reject and drops engine-specific generics', () => {
    expect(canvasFontFamilies('ui-monospace, JetBrains Mono, "Fira Code", Menlo, monospace'))
      .toBe('"JetBrains Mono", "Fira Code", Menlo, monospace');
    expect(canvasFontFamilies('ui-monospace')).toBeNull();
    expect(canvasFontFamilies('')).toBeNull();
  });

  test('keeps already quoted and single-ident names as they are', () => {
    expect(quoteFontFamilyName('"3270 Nerd Font"')).toBe('"3270 Nerd Font"');
    expect(quoteFontFamilyName('Menlo')).toBe('Menlo');
    expect(quoteFontFamilyName('M+ 1m')).toBe('"M+ 1m"');
  });
});

describe('areFontAdvancesMonospace', () => {
  test('accepts equal advances and treats unmeasurable input as monospace', () => {
    expect(areFontAdvancesMonospace([7.2, 7.2, 7.2])).toBe(true);
    expect(areFontAdvancesMonospace([7.2, 9.1, 7.2])).toBe(false);
    expect(areFontAdvancesMonospace([])).toBe(true);
    expect(areFontAdvancesMonospace([0, 0])).toBe(true);
  });
});
