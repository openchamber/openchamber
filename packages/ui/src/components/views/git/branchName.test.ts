import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { sanitizeBranchNameInput } from './branchName';

const gitAcceptsBranch = (name: string): boolean =>
  spawnSync('git', ['check-ref-format', '--branch', name]).status === 0;

describe('sanitizeBranchNameInput', () => {
  test('keeps names in any script as typed', () => {
    expect(sanitizeBranchNameInput('测试分支')).toBe('测试分支');
    expect(sanitizeBranchNameInput('feature/测试')).toBe('feature/测试');
    expect(sanitizeBranchNameInput('修复bug')).toBe('修复bug');
    expect(sanitizeBranchNameInput('виправлення/кнопка')).toBe('виправлення/кнопка');
    expect(sanitizeBranchNameInput('fix/#42-émoji-🙂')).toBe('fix/#42-émoji-🙂');
  });

  test('turns whitespace and characters git forbids into dashes', () => {
    expect(sanitizeBranchNameInput('  my new branch ')).toBe('my-new-branch');
    expect(sanitizeBranchNameInput('测试　分支')).toBe('测试-分支');
    expect(sanitizeBranchNameInput('a~b^c:d?e*f[g\\h')).toBe('a-b-c-d-e-f-g-h');
    expect(sanitizeBranchNameInput('a\tb\u0001c\u007fd')).toBe('a-b-c-d');
  });

  test('drops the sequences git refuses', () => {
    expect(sanitizeBranchNameInput('a..b')).toBe('a.b');
    expect(sanitizeBranchNameInput('a@{b')).toBe('a-b');
    expect(sanitizeBranchNameInput('//feature//.hidden/x.lock/')).toBe('feature/hidden/x');
    expect(sanitizeBranchNameInput('-feature-/-测试-')).toBe('feature/测试');
    expect(sanitizeBranchNameInput('release.')).toBe('release');
    expect(sanitizeBranchNameInput('@')).toBe('');
    expect(sanitizeBranchNameInput(' / ')).toBe('');
  });

  test('every non-empty result is a branch name git accepts', () => {
    const inputs = [
      '测试分支', 'feature/测试', ' a..b ', 'x@{-1}', '.a/.b.lock.', 'a/b.lock.-',
      '~^:?*[\\', '--x--', '测试/分支.lock', 'name.lock.lock', 'a/./b', 'é/ü/ñ',
    ];
    for (const input of inputs) {
      const name = sanitizeBranchNameInput(input);
      if (name) expect({ input, name, accepted: gitAcceptsBranch(name) }).toEqual({ input, name, accepted: true });
    }
  });
});
