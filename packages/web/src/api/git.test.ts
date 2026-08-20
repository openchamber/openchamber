import { describe, expect, it } from 'vitest';
import { createWebGitAPI } from './git';

describe('createWebGitAPI', () => {
  it('exposes the shared git HTTP surface', () => {
    const api = createWebGitAPI();

    expect(api).toEqual(expect.objectContaining({
      stageGitFiles: expect.any(Function),
      unstageGitFiles: expect.any(Function),
      stageGitHunk: expect.any(Function),
      unstageGitHunk: expect.any(Function),
      revertGitHunk: expect.any(Function),
      getGitHistoryRefs: expect.any(Function),
      getGitHistory: expect.any(Function),
      getGitHistoryMergeBase: expect.any(Function),
      getCommitFiles: expect.any(Function),
      getCommitFileDiff: expect.any(Function),
    }));
  });
});
