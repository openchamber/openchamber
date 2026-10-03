import { describe, expect, test } from 'bun:test';

import { resolveDefaultSourceBranch } from './worktreeSourceBranchPreference';

describe('resolveDefaultSourceBranch', () => {
  test('starts from the branch the project root is on', () => {
    expect(resolveDefaultSourceBranch({ branches: ['develop', 'main'], rootBranch: 'develop' })).toBe('develop');
  });

  test('falls back to main, then master, then the first branch', () => {
    expect(resolveDefaultSourceBranch({ branches: ['feature/x', 'main'], rootBranch: null })).toBe('main');
    expect(resolveDefaultSourceBranch({ branches: ['feature/x', 'master'], rootBranch: 'gone' })).toBe('master');
    expect(resolveDefaultSourceBranch({ branches: ['feature/x'], rootBranch: null })).toBe('feature/x');
    expect(resolveDefaultSourceBranch({ branches: [], rootBranch: null })).toBe('');
  });
});
