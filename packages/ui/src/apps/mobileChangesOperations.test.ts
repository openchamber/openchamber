import { describe, expect, test } from 'bun:test';

import { settleGitFileReverts } from './mobileChangesOperations';

describe('settleGitFileReverts', () => {
  test('waits for every unique path and reports partial failures', async () => {
    const completed: string[] = [];

    const result = await settleGitFileReverts(['slow.ts', 'failed.ts', 'slow.ts'], async (path) => {
      if (path === 'failed.ts') throw new Error('revert failed');
      await Promise.resolve();
      completed.push(path);
    });

    expect(completed).toEqual(['slow.ts']);
    expect(result.paths).toEqual(['slow.ts', 'failed.ts']);
    expect(result.failures.map((failure) => failure.path)).toEqual(['failed.ts']);
    expect(result.failures[0]?.error?.message).toBe('revert failed');
  });
});
