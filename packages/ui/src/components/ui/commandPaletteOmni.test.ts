import { expect, test } from 'bun:test';

import { nextPaletteCategory, paletteLifecycle, shouldResetPaletteCategory } from './commandPaletteOmni';

test('cycles palette categories in both directions and wraps', () => {
  expect(nextPaletteCategory('all', 1)).toBe('sessions');
  expect(nextPaletteCategory('all', -1)).toBe('files');
  expect(nextPaletteCategory('files', 1)).toBe('all');
});

test('preference overrides archived lifecycle flags', () => {
  expect(paletteLifecycle(false, 'archived')).toBe('active');
  expect(paletteLifecycle(false, 'all')).toBe('active');
  expect(paletteLifecycle(true, 'archived')).toBe('archived');
  expect(paletteLifecycle(true, undefined)).toBe('all');
});

test('only empty Backspace and Escape reset a non-default category', () => {
  expect(shouldResetPaletteCategory('sessions', 'Escape', 'query')).toBe(true);
  expect(shouldResetPaletteCategory('messages', 'Backspace', '')).toBe(true);
  expect(shouldResetPaletteCategory('messages', 'Backspace', 'query')).toBe(false);
  expect(shouldResetPaletteCategory('all', 'Escape', '')).toBe(false);
});
