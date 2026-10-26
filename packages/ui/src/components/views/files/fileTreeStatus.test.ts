import { expect, test } from 'bun:test';
import { areDirectoryNodesEqual, buildFileTreeStatusIndex } from './fileTreeStatus';

test('directory equality preserves no-op snapshots and includes every rendered field and ordering', () => {
  const nodes: Parameters<typeof areDirectoryNodesEqual>[0] = [
    { name: 'a.ts', path: '/a.ts', type: 'file', extension: 'ts', relativePath: 'a.ts' },
    { name: 'b', path: '/b', type: 'directory' },
  ];
  expect(areDirectoryNodesEqual(nodes, nodes.map(node => ({ ...node })))).toBe(true);
  expect(areDirectoryNodesEqual(nodes, [...nodes].reverse())).toBe(false);
  expect(areDirectoryNodesEqual(nodes, nodes.slice(0, 1))).toBe(false);
  for (const change of [{ name: 'other' }, { path: '/other' }, { extension: 'js' }, { relativePath: 'other' }]) {
    expect(areDirectoryNodesEqual(nodes, [{ ...nodes[0], ...change }, nodes[1]])).toBe(false);
  }
  expect(areDirectoryNodesEqual(nodes, [{ ...nodes[0], type: 'directory' }, nodes[1]])).toBe(false);
});

test('status precedence, duplicate paths and ancestor badges match the original scans', () => {
  const index = buildFileTreeStatusIndex([
    { path: 'a/b.ts', index: 'A', working_dir: 'M' },
    { path: 'a/deleted.ts', index: 'D', working_dir: ' ' },
    { path: 'ab/other.ts', index: 'M', working_dir: ' ' },
    { path: 'root.ts', index: ' ', working_dir: '?' },
    { path: 'a/b.ts', index: 'D', working_dir: ' ' },
  ]);
  expect(index.statusByPath.get('a/b.ts')).toBe('git-added');
  expect(index.statusByPath.get('a/deleted.ts')).toBe('git-deleted');
  expect(index.statusByPath.get('root.ts')).toBe('git-added');
  expect(index.badgeByDir.get('a')).toEqual({ modified: 1, added: 1 });
  expect(index.badgeByDir.get('ab')).toEqual({ modified: 1, added: 0 });
  expect(index.badgeByDir.get('')).toEqual({ modified: 2, added: 2 });
  expect(index.badgeByDir.get('missing')).toBeUndefined();
});
