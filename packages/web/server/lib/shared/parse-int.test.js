import { describe, expect, it } from 'vitest';

import { parseBoundedIntWithDefault, parsePositiveIntWithDefault } from './parse-int.js';

describe('parsePositiveIntWithDefault', () => {
  it.each([
    ['250', 250],
    [' 250 ', 250],
    ['1', 1],
  ])('parses %j', (raw, expected) => {
    expect(parsePositiveIntWithDefault(raw, 99)).toBe(expected);
  });

  it.each(['5000junk', '1e3', '0x10', '5.9', '', '  ', '-5', '0', '+5', 'NaN', 'Infinity', null, undefined])(
    'falls back for %j',
    (raw) => {
      expect(parsePositiveIntWithDefault(raw, 99)).toBe(99);
    },
  );

  it('falls back past the safe-integer range', () => {
    expect(parsePositiveIntWithDefault('99999999999999999999', 99)).toBe(99);
  });
});

describe('parseBoundedIntWithDefault', () => {
  it.each([
    ['0', 0],
    [' 42 ', 42],
    ['100', 100],
  ])('parses %j inside [0, 100]', (raw, expected) => {
    expect(parseBoundedIntWithDefault(raw, 7, 0, 100)).toBe(expected);
  });

  it.each(['101', '-1', '5000junk', '1e3', '0x10', '5.9', '', '  ', null, undefined])(
    'falls back for %j outside the spelling or the bounds',
    (raw) => {
      expect(parseBoundedIntWithDefault(raw, 7, 0, 100)).toBe(7);
    },
  );
});
