import { describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';

import { importCandidates, joinPath, relativeImportAt, resolveRelativeImport, type ListDirectoryNames } from './importLinks';

const linkAt = (doc: string, needle: string) => {
  const state = EditorState.create({ doc, extensions: [javascript({ typescript: true })] });
  ensureSyntaxTree(state, state.doc.length, 5_000);
  return relativeImportAt(state, doc.indexOf(needle) + 1)?.specifier ?? null;
};

describe('relativeImportAt', () => {
  test('finds relative paths in imports, re-exports, dynamic imports and require', () => {
    expect(linkAt(`import a from './a';`, './a')).toBe('./a');
    expect(linkAt(`export { b } from "../b";`, '../b')).toBe('../b');
    expect(linkAt(`const d = await import('./d');`, './d')).toBe('./d');
    expect(linkAt(`const e = require('./e');`, './e')).toBe('./e');
  });

  test('ignores packages, aliases and strings that are not imports', () => {
    expect(linkAt(`import React from 'react';`, 'react')).toBeNull();
    expect(linkAt(`import x from '@/lib/x';`, '@/lib')).toBeNull();
    expect(linkAt(`const s = './not-an-import';`, './not')).toBeNull();
    expect(linkAt(`const e = load('./e');`, './e')).toBeNull();
  });
});

describe('resolving a relative import', () => {
  test('joins and folds the path', () => {
    expect(joinPath('/repo/src/lib', '../ui/./button')).toBe('/repo/src/ui/button');
    expect(importCandidates('/repo/src/a.ts', './b.js').slice(0, 3)).toEqual(['/repo/src/b.js', '/repo/src/b.ts', '/repo/src/b.tsx']);
  });

  const tree = new Map([
    ['/repo/src', new Map([['a.ts', false], ['b.ts', false], ['c.tsx', false], ['lib', true], ['styles.css', false]])],
    ['/repo/src/lib', new Map([['index.ts', false]])],
  ]);
  const listNames: ListDirectoryNames = async (directory) => {
    const names = tree.get(directory);
    if (!names) throw new Error(`listed a folder that does not exist: ${directory}`);
    return names;
  };

  test('finds the source file the way a bundler would', async () => {
    expect(await resolveRelativeImport('/repo/src/a.ts', './b', listNames)).toEqual({ status: 'found', path: '/repo/src/b.ts' });
    expect(await resolveRelativeImport('/repo/src/a.ts', './b.js', listNames)).toEqual({ status: 'found', path: '/repo/src/b.ts' });
    expect(await resolveRelativeImport('/repo/src/a.ts', './c', listNames)).toEqual({ status: 'found', path: '/repo/src/c.tsx' });
    expect(await resolveRelativeImport('/repo/src/a.ts', './lib', listNames)).toEqual({ status: 'found', path: '/repo/src/lib/index.ts' });
    expect(await resolveRelativeImport('/repo/src/a.ts', './styles.css', listNames)).toEqual({ status: 'found', path: '/repo/src/styles.css' });
  });

  test('a missing file is missing, without listing folders that are not there', async () => {
    expect(await resolveRelativeImport('/repo/src/a.ts', './nope', listNames)).toEqual({ status: 'missing' });
  });

  test('a listing that fails is not reported as a missing file', async () => {
    const failing: ListDirectoryNames = async () => null;
    expect(await resolveRelativeImport('/repo/src/a.ts', './b', failing)).toEqual({ status: 'failed' });
  });
});
