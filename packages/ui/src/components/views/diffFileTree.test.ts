import { describe, expect, test } from 'bun:test';
import { buildDiffTreeRows } from './diffFileTree';

const files = [
  { path: 'packages/ui/src/a.ts' },
  { path: 'packages/ui/src/lib/b.ts' },
  { path: 'packages/web/c.js' },
  { path: 'README.md' },
];

const describeRows = (collapsed: string[]) =>
  buildDiffTreeRows(files, new Set(collapsed)).map((row) =>
    row.kind === 'directory' ? `${row.depth}:${row.label}/ (${row.fileCount})` : `${row.depth}:${row.name}`,
  );

describe('buildDiffTreeRows', () => {
  test('merges single-child directory chains and lists directories before files', () => {
    expect(describeRows([])).toEqual([
      '0:packages/ (3)',
      '1:ui/src/ (2)',
      '2:lib/ (1)',
      '3:b.ts',
      '2:a.ts',
      '1:web/ (1)',
      '2:c.js',
      '0:README.md',
    ]);
  });

  test('hides the contents of a collapsed directory by its merged path', () => {
    expect(describeRows(['packages/ui/src'])).toEqual([
      '0:packages/ (3)',
      '1:ui/src/ (2)',
      '1:web/ (1)',
      '2:c.js',
      '0:README.md',
    ]);
  });
});
