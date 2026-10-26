import { describe, expect, test } from 'bun:test';

import { flattenTree, parseJsonToTree, type FlatJsonNode } from './jsonTreeUtils';

const rows = (json: string, collapsed: string[] = []) =>
  flattenTree(parseJsonToTree(json), new Set(collapsed)).map((row: FlatJsonNode) =>
    `${row.kind === 'close' ? '/' : ''}${row.node.id}@${row.node.depth}`,
  );

describe('flattenTree closing rows', () => {
  test('closes every expanded container after its last child, at the container depth', () => {
    expect(rows('{"a":{"b":[1,2]},"c":3}')).toEqual([
      'root@0',
      'root.a@1',
      'root.a.b@2',
      'root.a.b[0]@3',
      'root.a.b[1]@3',
      '/root.a.b@2',
      '/root.a@1',
      'root.c@1',
      '/root@0',
    ]);
  });

  test('a collapsed container keeps a single row and no closing row', () => {
    expect(rows('{"a":{"b":1},"c":2}', ['root.a'])).toEqual([
      'root@0',
      'root.a@1',
      'root.c@1',
      '/root@0',
    ]);
  });

  test('empty containers get no closing row', () => {
    expect(rows('{"o":{},"l":[]}')).toEqual(['root@0', 'root.o@1', 'root.l@1', '/root@0']);
    expect(rows('[]')).toEqual(['root@0']);
  });

  test('containers past maxDepth have no children and no closing row', () => {
    const root = parseJsonToTree(JSON.stringify({ a: { b: { c: 1 } } }), { maxDepth: 1 });
    const flat = flattenTree(root, new Set());
    expect(flat.map((row) => `${row.kind}:${row.node.id}`)).toEqual([
      'node:root',
      'node:root.a',
      'close:root',
    ]);
  });

  test('a closing row key never collides with a node id, even for a key that looks like one', () => {
    const flat = flattenTree(parseJsonToTree(JSON.stringify({ 'close:root': { x: 1 } })), new Set());
    const keys = flat.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
