import { describe, expect, test } from 'bun:test';
import type { WorktreeMetadata } from '@/types/worktree';
import {
  buildProjectWorktreeIndex,
  buildWorktreeByPathIndex,
  findPrefixWorktreeEntry,
  resolveBranchLiveFirst,
} from './worktreeIndex';

const meta = (path: string, branch: string): WorktreeMetadata => ({
  path,
  projectDirectory: '/workspace/app',
  branch,
  label: branch,
});

describe('worktreeIndex shared exact index', () => {
  test('normalizes keys, excludes the owning project root, and keeps the first duplicate', () => {
    const index = buildWorktreeByPathIndex(
      new Map([
        ['/workspace/app', [
          meta('/workspace/app', 'root-branch'),
          meta('/tmp/wt-feature/', 'feature-1'),
          meta('/tmp/wt-feature', 'feature-duplicate'),
        ]],
      ]),
      [{ id: 'app', label: 'App', normalizedPath: '/workspace/app' }],
    );
    expect(index.has('/workspace/app')).toBe(false);
    expect(index.get('/tmp/wt-feature')?.meta.branch).toBe('feature-1');
    expect(index.get('/tmp/wt-feature')?.project.id).toBe('app');
  });

  test('per-project index excludes its root and keeps the first duplicate', () => {
    const index = buildProjectWorktreeIndex(
      [meta('/workspace/app', 'root'), meta('/tmp/wt-a', 'a-first'), meta('/tmp/wt-a', 'a-second')],
      '/workspace/app',
    );
    expect(index.has('/workspace/app')).toBe(false);
    expect(index.get('/tmp/wt-a')?.branch).toBe('a-first');
  });

  test('prefix lookup prefers the longest containing worktree and includes exact matches', () => {
    const index = buildWorktreeByPathIndex(
      new Map([
        ['/workspace/app', [
          meta('/tmp/wt', 'outer'),
          meta('/tmp/wt/nested', 'inner'),
        ]],
      ]),
      [{ id: 'app', label: 'App', normalizedPath: '/workspace/app' }],
    );
    expect(findPrefixWorktreeEntry('/tmp/wt', index)?.meta.branch).toBe('outer');
    expect(findPrefixWorktreeEntry('/tmp/wt/sub', index)?.meta.branch).toBe('outer');
    expect(findPrefixWorktreeEntry('/tmp/wt/nested/sub', index)?.meta.branch).toBe('inner');
    expect(findPrefixWorktreeEntry('/tmp/other', index)).toBeNull();
    expect(findPrefixWorktreeEntry('/tmp/wt-other', index)).toBeNull();
  });

  test('live branch wins over stored metadata, with worktree-root fallback for subdirectories', () => {
    const gitBranches = new Map<string, string | null>([['/tmp/wt-feature', 'live-1']]);
    expect(resolveBranchLiveFirst('/tmp/wt-feature', '/tmp/wt-feature', 'stored-1', gitBranches)).toBe('live-1');
    expect(resolveBranchLiveFirst('/tmp/wt-feature/sub', '/tmp/wt-feature', 'stored-1', gitBranches)).toBe('live-1');
    expect(resolveBranchLiveFirst('/tmp/wt-feature/sub', '/tmp/wt-feature', 'stored-1', new Map())).toBe('stored-1');
    expect(resolveBranchLiveFirst('/tmp/wt-feature', '/tmp/wt-feature', '  ', new Map())).toBeNull();
  });
});
