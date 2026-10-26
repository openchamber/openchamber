import { describe, expect, test } from 'bun:test';
import { Text } from '@codemirror/state';

import { detectIndentWidth, guideLevel, leadingColumns } from './indentGuides';

const doc = (...lines: string[]) => Text.of(lines);

describe('indent guides', () => {
  test('counts tabs to the next tab stop', () => {
    expect(leadingColumns('  \tx', 4)).toBe(4);
    expect(leadingColumns('    ', 4)).toBeNull();
  });

  test('takes the most common indent step as the width', () => {
    expect(detectIndentWidth(doc('a {', '    b {', '        c', '    }', '}'), 4)).toBe(4);
    expect(detectIndentWidth(doc('a:', '  b:', '    c: 1', '  d: 2'), 4)).toBe(2);
    expect(detectIndentWidth(doc('f() {', '\tx', '}'), 4)).toBe(4);
    // A continuation line one column in does not count.
    expect(detectIndentWidth(doc('/**', ' * doc', ' */', 'a {', '  b', '}'), 4)).toBe(2);
  });

  test('a blank line takes the deeper neighbour, so guides run through it', () => {
    const text = doc('a {', '    b', '', '    c', '}', '', 'd');
    const level = (number: number) => guideLevel(text, text.line(number), 4, 4);
    expect([1, 2, 3, 4, 5, 6, 7].map(level)).toEqual([0, 1, 1, 1, 0, 0, 0]);
  });
});
