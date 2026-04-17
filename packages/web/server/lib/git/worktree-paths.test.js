import { describe, expect, it } from 'bun:test';

import { buildWorktreeRoot, clampWorktreeLeafName, shortProjectId, worktreeDir } from './worktree-paths.js';

describe('git worktree paths', () => {
  it('shortens project ids for worktree roots', () => {
    expect(shortProjectId('0123456789abcdef0123456789abcdef01234567')).toBe('0123456789ab');
  });

  it('clamps worktree leaf names to a short length', () => {
    expect(clampWorktreeLeafName('feature-branch-name-that-is-way-too-long')).toBe('feature-branch-name-that');
  });

  it('produces shorter worktree paths than the previous layout', () => {
    const dataRoot = '/Users/test/.local/share/opencode';
    const projectId = '0123456789abcdef0123456789abcdef01234567';
    const leafName = 'feature-branch-name-that-is-way-too-long';

    const next = worktreeDir(buildWorktreeRoot(dataRoot, projectId), leafName);
    const previous = `${dataRoot}/worktree/${projectId}/${leafName}`;

    expect(next.length).toBeLessThan(previous.length);
  });
});
