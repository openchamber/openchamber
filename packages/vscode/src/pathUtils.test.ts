import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { pathsEqualWithNormalizedDriveLetter } from './pathUtils';

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
