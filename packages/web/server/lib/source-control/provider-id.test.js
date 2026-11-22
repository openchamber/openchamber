import { describe, expect, it } from 'vitest';
import { isProviderUsername } from './provider-id.js';

describe('isProviderUsername', () => {
  it.each(['alice', 'jane@corp.com', 'first+tag', 'Jane Doe', 'a.b_c-d', '~user!', 'x'.repeat(256)])('takes %j', (value) => {
    expect(isProviderUsername(value)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['a colon, the Basic separator', 'jane:doe'],
    ['a NUL', 'jane\0'],
    ['a newline', 'jane\ndoe'],
    ['a tab', 'jane\tdoe'],
    ['DEL', 'jane\x7f'],
    ['a C1 control', 'jane\u0085'],
    ['a non-ASCII letter', 'jürgen'],
    ['a surrounding space', ' jane'],
    ['too long', 'x'.repeat(257)],
    ['not a string', 42],
  ])('refuses %s', (_name, value) => {
    expect(isProviderUsername(value)).toBe(false);
  });
});
