import { describe, expect, test } from 'bun:test';

import { findTextPosition } from './textPosition';

describe('findTextPosition', () => {
  for (const { label, trailingNodes } of [
    { label: 'without a trailing newline', trailingNodes: [] },
    { label: 'with a trailing newline', trailingNodes: [{ data: '\n' }] },
  ]) {
    test(`maps a second-line match start to visible content ${label}`, () => {
      const firstLine = { data: 'output:' };
      const hiddenLineBreak = { data: '\n' };
      const secondLine = { data: 'src/index.ts:12' };
      const nodes = [firstLine, hiddenLineBreak, secondLine, ...trailingNodes];
      const startOffset = firstLine.data.length + hiddenLineBreak.data.length;

      expect(findTextPosition(nodes, startOffset, 'right')).toEqual({ node: secondLine, offset: 0 });
      expect(findTextPosition(nodes, startOffset + secondLine.data.length, 'left')).toEqual({
        node: secondLine,
        offset: secondLine.data.length,
      });
    });
  }

  test('keeps an end boundary on the preceding text node', () => {
    const firstLine = { data: 'src/index.ts:12' };
    const hiddenLineBreak = { data: '\n' };

    expect(findTextPosition([firstLine, hiddenLineBreak], firstLine.data.length, 'left')).toEqual({
      node: firstLine,
      offset: firstLine.data.length,
    });
  });
});
