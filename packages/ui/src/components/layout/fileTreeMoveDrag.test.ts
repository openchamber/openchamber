import { describe, expect, test } from 'bun:test';

import { getFileTreeMovedPath, getFileTreeMoveTarget, type FileTreeEntry } from './fileTreeMoveDrag';

const root = '/repo';
const file = (path: string): FileTreeEntry => ({ path, type: 'file' });
const folder = (path: string): FileTreeEntry => ({ path, type: 'directory' });

describe('getFileTreeMoveTarget', () => {
  test('a folder row is the target', () => {
    expect(getFileTreeMoveTarget(file('/repo/src/a.ts'), folder('/repo/lib'), root)).toBe('/repo/lib');
  });

  test('a file row stands for the folder it is in', () => {
    expect(getFileTreeMoveTarget(file('/repo/src/a.ts'), file('/repo/lib/b.ts'), root)).toBe('/repo/lib');
  });

  test('empty space below the tree stands for the root', () => {
    expect(getFileTreeMoveTarget(file('/repo/src/a.ts'), null, root)).toBe('/repo');
  });

  test('refuses the folder the entry already lives in', () => {
    expect(getFileTreeMoveTarget(file('/repo/src/a.ts'), folder('/repo/src'), root)).toBeNull();
    expect(getFileTreeMoveTarget(file('/repo/src/a.ts'), file('/repo/src/b.ts'), root)).toBeNull();
    expect(getFileTreeMoveTarget(file('/repo/src/a.ts'), file('/repo/src/a.ts'), root)).toBeNull();
    expect(getFileTreeMoveTarget(file('/repo/a.ts'), null, root)).toBeNull();
  });

  test('refuses moving a folder onto itself or into its own subfolders', () => {
    expect(getFileTreeMoveTarget(folder('/repo/src'), folder('/repo/src'), root)).toBeNull();
    expect(getFileTreeMoveTarget(folder('/repo/src'), folder('/repo/src/deep'), root)).toBeNull();
    expect(getFileTreeMoveTarget(folder('/repo/src'), file('/repo/src/deep/a.ts'), root)).toBeNull();
  });

  test('accepts a sibling folder that only shares a name prefix', () => {
    expect(getFileTreeMoveTarget(folder('/repo/src'), folder('/repo/srcx'), root)).toBe('/repo/srcx');
  });
});

describe('getFileTreeMovedPath', () => {
  test('keeps the entry name inside the target folder', () => {
    expect(getFileTreeMovedPath(file('/repo/src/a.ts'), '/repo/lib')).toBe('/repo/lib/a.ts');
    expect(getFileTreeMovedPath(folder('/repo/src'), '/')).toBe('/src');
  });
});
