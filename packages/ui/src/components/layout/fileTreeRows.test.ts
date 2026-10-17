import { describe, expect, test } from 'bun:test';

import { buildFileTreeRows, withPinnedRowIndexes } from './fileTreeRows';

type Node = { name: string; path: string; type: 'file' | 'directory' };
const dir = (path: string): Node => ({ name: path.split('/').pop() ?? path, path, type: 'directory' });
const file = (path: string): Node => ({ name: path.split('/').pop() ?? path, path, type: 'file' });

const childrenByDir = {
  '/r': [dir('/r/a'), dir('/r/b'), file('/r/c.ts')],
  '/r/a': [dir('/r/a/x'), file('/r/a/y.ts')],
  '/r/a/x': [file('/r/a/x/z.ts')],
  '/r/b': [file('/r/b/w.ts')],
} satisfies Record<string, Node[]>;

const describeRows = (rows: ReturnType<typeof buildFileTreeRows<Node>>) => rows.map((row) => (
  row.kind === 'node' ? `${'  '.repeat(row.depth)}${row.node.name}${row.isExpanded ? '/' : ''}` : `${'  '.repeat(row.depth)}! ${row.message}`
));

describe('buildFileTreeRows', () => {
  test('lists expanded folders depth first, in their listing order', () => {
    const rows = buildFileTreeRows({ root: '/r', childrenByDir, expandedPaths: new Set(['/r/a', '/r/a/x']), loadErrorsByDir: {} });
    expect(describeRows(rows)).toEqual(['a/', '  x/', '    z.ts', '  y.ts', 'b', 'c.ts']);
  });

  test('a collapsed folder hides its descendants even when they are expanded', () => {
    const rows = buildFileTreeRows({ root: '/r', childrenByDir, expandedPaths: new Set(['/r/a/x']), loadErrorsByDir: {} });
    expect(describeRows(rows)).toEqual(['a', 'b', 'c.ts']);
  });

  test("an expanded folder's load error sits right under it, above what is still listed", () => {
    const rows = buildFileTreeRows({ root: '/r', childrenByDir, expandedPaths: new Set(['/r/b']), loadErrorsByDir: { '/r/b': 'denied', '/r/a': 'hidden while collapsed' } });
    expect(describeRows(rows)).toEqual(['a', 'b/', '  ! denied', '  w.ts', 'c.ts']);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  test('an expanded folder that is not loaded yet has no rows under it', () => {
    const rows = buildFileTreeRows({ root: '/r', childrenByDir: { '/r': [dir('/r/a')] }, expandedPaths: new Set(['/r/a']), loadErrorsByDir: {} });
    expect(describeRows(rows)).toEqual(['a/']);
  });
});

describe('withPinnedRowIndexes', () => {
  test('adds pinned rows outside the range, in order', () => {
    expect(withPinnedRowIndexes([10, 11, 12], [40, 2], 50)).toEqual([2, 10, 11, 12, 40]);
  });

  test('ignores pinned rows already in range, missing (-1) or past the end', () => {
    expect(withPinnedRowIndexes([3, 4], [4, -1, 9], 5)).toEqual([3, 4]);
  });
});
