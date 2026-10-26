import { describe, expect, test } from 'bun:test';
import { resolveWorkspaceFolders } from './workspaceResolver.ts';

const ALPHA = { name: 'alpha', uri: { fsPath: '/work/alpha' } };
const BRAVO = { name: 'Bravo', uri: { fsPath: '/work/bravo' } };
const CHARLIE = { name: 'Charlie', uri: { fsPath: '/work/charlie' } };
const ALPHA_DUP = { name: 'alpha-dup', uri: { fsPath: '/work/alpha' } };
const ALPHA_WITH_TRAILING = { name: 'alpha', uri: { fsPath: '/work/alpha///' } };
const BRAVO_WITH_TRAILING = { name: 'bravo', uri: { fsPath: '/work/bravo//' } };

describe('resolveWorkspaceFolders', () => {
  describe('when the input is empty', () => {
    test('returns an empty list without throwing', () => {
      expect(resolveWorkspaceFolders([])).toEqual([]);
    });
  });

  describe('when a single folder is provided', () => {
    test('preserves its name and path', () => {
      expect(resolveWorkspaceFolders([ALPHA])).toEqual([
        { name: 'alpha', path: '/work/alpha' },
      ]);
    });
  });

  describe('when multiple folders are provided', () => {
    test('returns them sorted alphabetically by name, case-insensitive', () => {
      const result = resolveWorkspaceFolders([CHARLIE, ALPHA, BRAVO]);

      expect(result.map((entry) => entry.name)).toEqual([
        'alpha',
        'Bravo',
        'Charlie',
      ]);
    });
  });

  describe('when folders share the same path', () => {
    test('keeps only the first occurrence and discards duplicates by path', () => {
      const result = resolveWorkspaceFolders([ALPHA, ALPHA_DUP, BRAVO]);

      expect(result).toEqual([
        { name: 'alpha', path: '/work/alpha' },
        { name: 'Bravo', path: '/work/bravo' },
      ]);
    });
  });

  describe('when paths contain trailing separators', () => {
    test('strips them from every returned path', () => {
      const result = resolveWorkspaceFolders([
        ALPHA_WITH_TRAILING,
        BRAVO_WITH_TRAILING,
      ]);

      expect(result).toEqual([
        { name: 'alpha', path: '/work/alpha' },
        { name: 'bravo', path: '/work/bravo' },
      ]);
    });

    test('treats paths that differ only by trailing separators as the same folder', () => {
      const result = resolveWorkspaceFolders([ALPHA_WITH_TRAILING, ALPHA_DUP]);

      expect(result).toEqual([{ name: 'alpha', path: '/work/alpha' }]);
    });
  });
});
