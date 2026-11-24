import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { isPathInside, pathsEqualWithNormalizedDriveLetter } from './pathUtils';

describe('pathsEqualWithNormalizedDriveLetter', () => {
  test('matches Windows paths that differ only in drive-letter case', () => {
    assert.equal(
      pathsEqualWithNormalizedDriveLetter('C:\\Users\\user\\project', 'c:\\Users\\user\\project'),
      true
    );
  });

  test('does not ignore case outside the drive letter', () => {
    assert.equal(
      pathsEqualWithNormalizedDriveLetter('C:\\Users\\user\\project', 'C:\\Users\\User\\project'),
      false
    );
  });

  test('preserves exact comparison for paths without a Windows drive letter', () => {
    assert.equal(pathsEqualWithNormalizedDriveLetter('/work/project', '/work/project'), true);
    assert.equal(pathsEqualWithNormalizedDriveLetter('/work/project', '/work/other'), false);
  });
});

describe('isPathInside', () => {
  test('accepts descendants of a POSIX filesystem root', () => {
    assert.equal(isPathInside('/Users/user/notes.txt', '/', path.posix), true);
    assert.equal(isPathInside('/', '/', path.posix), true);
  });

  test('accepts descendants of a Windows drive root', () => {
    assert.equal(isPathInside('C:\\work\\notes.txt', 'C:\\', path.win32), true);
    assert.equal(isPathInside('c:\\work\\notes.txt', 'C:/', path.win32), true);
    assert.equal(isPathInside('D:\\work\\notes.txt', 'C:\\', path.win32), false);
  });

  test('rejects siblings that share a directory name prefix', () => {
    assert.equal(isPathInside('/work/project-other/a.txt', '/work/project', path.posix), false);
    assert.equal(isPathInside('/work/project/a.txt', '/work/project', path.posix), true);
    assert.equal(isPathInside('C:\\work\\project-other\\a.txt', 'C:\\work\\project', path.win32), false);
  });
});
