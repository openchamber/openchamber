import { expect, test } from 'bun:test';
import { customFontStack } from './fontOptions';

const fallback = 'ui-monospace, "SFMono-Regular", monospace';

test('a single family is quoted and followed by the fallback', () => {
  expect(customFontStack('Maple Mono NF CN', fallback)).toBe(`"Maple Mono NF CN", ${fallback}`);
});

test('a comma list becomes one quoted family per entry, then the fallback', () => {
  expect(customFontStack('"Cascadia Mono", "Microsoft YaHei"', fallback))
    .toBe(`"Cascadia Mono", "Microsoft YaHei", ${fallback}`);
});

test('empty entries are dropped and characters that could end the value are stripped', () => {
  expect(customFontStack(' Inter , , Geo;rgia{} ', fallback))
    .toBe(`"Inter", "Georgia", ${fallback}`);
});

test('a value with no usable family returns the fallback alone', () => {
  expect(customFontStack('  , ; {} ', fallback)).toBe(fallback);
  expect(customFontStack('', fallback)).toBe(fallback);
});
