import { describe, expect, test } from 'bun:test';

import { getNormalizedParentDirectory, normalizePath } from './pathNormalization';
import { normalizePath as normalizeMobilePath } from '../apps/mobilePaths';

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

    test('preserves an absolute Windows drive root', () => {
      expect(normalizePath('C:/')).toBe('C:/');
      expect(normalizePath('c:\\')).toBe('C:/');
      expect(normalizePath('C:////')).toBe('C:/');
      expect(normalizePath('C:')).toBe('C:');
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

  test('normalizes UNC separators without dropping the server or share', () => {
    expect(normalizePath('\\\\Server\\Share\\Project\\')).toBe('//Server/Share/Project');
    expect(normalizePath('//Server/Share/Project')).toBe('//Server/Share/Project');
    expect(normalizePath('\\\\Server\\Share\\')).toBe('//Server/Share');
  });

  test('preserves verbatim Windows namespaces and literal path names', () => {
    expect(normalizePath('\\\\?\\C:\\Users\\Developer\\Project')).toBe('//?/C:/Users/Developer/Project');
    expect(normalizePath('\\\\?\\C:\\')).toBe('//?/C:/');
    expect(normalizePath('\\\\?\\UNC\\Server\\Share\\Project')).toBe('//?/UNC/Server/Share/Project');
    expect(normalizePath('C:\\Users\\Ірина\\Project with spaces\\100%')).toBe('C:/Users/Ірина/Project with spaces/100%');
  });

  test('parent traversal stops at drive and UNC share roots', () => {
    expect(getNormalizedParentDirectory('C:/Users')).toBe('C:/');
    expect(getNormalizedParentDirectory('C:/')).toBeNull();
    expect(getNormalizedParentDirectory('//?/C:/Users')).toBe('//?/C:/');
    expect(getNormalizedParentDirectory('//?/C:/')).toBeNull();
    expect(getNormalizedParentDirectory('//Server/Share/Folder')).toBe('//Server/Share');
    expect(getNormalizedParentDirectory('//Server/Share')).toBeNull();
    expect(getNormalizedParentDirectory('//?/UNC/Server/Share')).toBeNull();
    expect(getNormalizedParentDirectory('/folder')).toBe('/');
    expect(getNormalizedParentDirectory('/')).toBeNull();
  });

  test('mobile session paths preserve the same filesystem roots', () => {
    expect(normalizeMobilePath('c:\\')).toBe('C:/');
    expect(normalizeMobilePath('/')).toBe('/');
    expect(normalizeMobilePath('\\\\Server\\Share\\')).toBe('//Server/Share');
  });
});
