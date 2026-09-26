import { describe, expect, it } from 'vitest';

import {
  copyGitProcessMetadata,
  createGitProcessError,
  isGitProcessCleanupBlocked,
} from './execution-errors.js';

describe('Git process result/error adapters', () => {
  it('preserves termination metadata through result and error boundaries', () => {
    const result = copyGitProcessMetadata({
      success: false,
      exitCode: null,
      stdout: '',
      stderr: '',
    }, {
      code: 'ERR_PROCESS_TREE_TERMINATION',
      cleanupBlocked: true,
      descendantsTerminated: false,
      rootClosed: false,
      pid: 8080,
    });
    const error = createGitProcessError(result, 'Git command failed');

    expect(result).toMatchObject({
      code: 'ERR_PROCESS_TREE_TERMINATION',
      cleanupBlocked: true,
      descendantsTerminated: false,
      rootClosed: false,
      pid: 8080,
    });
    expect(error).toMatchObject({
      code: 'ERR_PROCESS_TREE_TERMINATION',
      cleanupBlocked: true,
      descendantsTerminated: false,
      rootClosed: false,
      pid: 8080,
    });
    expect(isGitProcessCleanupBlocked(error)).toBe(true);
  });

  it('recognizes metadata nested in an adapter error field', () => {
    expect(isGitProcessCleanupBlocked({
      error: {
        code: 'ERR_PROCESS_TREE_TERMINATION',
        descendantsTerminated: false,
      },
    })).toBe(true);
  });

  it.each([
    ['status', { current: '', files: [], isClean: true }],
    ['untracked list', []],
    ['untracked diff', ''],
  ])('keeps cleanup-blocked %s failures out of empty fallbacks', (_operation, fallback) => {
    const result = copyGitProcessMetadata({ success: false, stdout: '', stderr: '', exitCode: null }, {
      code: 'ERR_PROCESS_TREE_TERMINATION',
      cleanupBlocked: true,
      descendantsTerminated: false,
      rootClosed: false,
      pid: 8080,
    });

    expect(() => {
      if (isGitProcessCleanupBlocked(result)) throw createGitProcessError(result);
      return fallback;
    }).toThrowError(expect.objectContaining({
      code: 'ERR_PROCESS_TREE_TERMINATION',
      cleanupBlocked: true,
      descendantsTerminated: false,
      pid: 8080,
    }));
  });
});
