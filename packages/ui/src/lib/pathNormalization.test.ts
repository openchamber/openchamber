import { describe, expect, test } from 'bun:test';

import { normalizePath } from './pathNormalization';

describe('normalizePath', () => {
  describe('non-string inputs', () => {
    test('returns null for null', () => {
      expect(normalizePath(null)).toBeNull();
    });

    test('returns null for undefined', () => {
      expect(normalizePath(undefined)).toBeNull();
    });

    test('returns null for empty string', () => {
      expect(normalizePath('')).toBeNull();
    });

    test('returns null for whitespace-only', () => {
      expect(normalizePath('   ')).toBeNull();
    });
  });

  describe('backslashes', () => {
    test('converts backslashes to forward slashes', () => {
      expect(normalizePath('C:\\Users\\me\\project')).toBe('C:/Users/me/project');
    });
  });

  describe('drive letter casing', () => {
    test('uppercases lowercase Windows drive letter', () => {
      expect(normalizePath('c:\\Users\\me\\project')).toBe('C:/Users/me/project');
    });

    test('preserves already-uppercase drive letter', () => {
      expect(normalizePath('C:\\Users\\me\\project')).toBe('C:/Users/me/project');
    });

    test('does not match multi-character tokens before colon', () => {
      expect(normalizePath('abc:def')).toBe('abc:def');
    });

    test('does not touch drive letter in middle of path', () => {
      // Only the leading drive letter is touched; a "c:" later in the
      // path is left alone (no upper-casing, no backslash conversion of
      // the surrounding characters beyond the backslash-to-slash step).
      expect(normalizePath('/foo/c:\\bar')).toBe('/foo/c:/bar');
    });
  });

  describe('trailing slashes', () => {
    test('strips a single trailing slash', () => {
      expect(normalizePath('C:/Users/me/')).toBe('C:/Users/me');
    });

    test('strips multiple trailing slashes', () => {
      expect(normalizePath('C:/Users/me///')).toBe('C:/Users/me');
    });

    test('preserves root /', () => {
      expect(normalizePath('/')).toBe('/');
    });

    test('preserves single-char after slash strip', () => {
      expect(normalizePath('C:/')).toBe('C:');
    });
  });

  describe('degenerate slash-only inputs', () => {
    // '///' → stays '///' after backslash replace → trailing-slash strip
    // yields '' → null. This is the new defensive behavior.
    test('returns null for multiple forward slashes', () => {
      expect(normalizePath('///')).toBeNull();
    });

    // '\\\\' in source = 2 backslash chars → replace to '//' → strip → '' → null.
    test('returns null for multiple backslashes', () => {
      expect(normalizePath('\\\\')).toBeNull();
    });

    // A single backslash '\\' is normalized to a single forward slash
    // and treated as the filesystem root, returned as '/'. (This is the
    // pre-existing behavior; the defensive fix only adds null for
    // slash-only inputs that strip down to ''.)
    test('normalizes a single backslash to the root "/"', () => {
      expect(normalizePath('\\')).toBe('/');
    });
  });

  describe('Unix paths', () => {
    test('passes through a Unix path unchanged', () => {
      expect(normalizePath('/home/user/project')).toBe('/home/user/project');
    });

    test('strips trailing slashes from Unix paths', () => {
      expect(normalizePath('/home/user/project/')).toBe('/home/user/project');
    });
  });
});
