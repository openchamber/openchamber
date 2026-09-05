import { describe, expect, test } from 'bun:test';
import type { GitRemote } from '@/lib/api/types';
import { buildGitHubCommitUrl, selectGitCommitHoverRemote } from './gitCommitRemote';

describe('selectGitCommitHoverRemote', () => {
  test('prefers origin over other remotes and uses the fetch url before the push url', () => {
    const remotes: GitRemote[] = [
      {
        name: 'upstream',
        fetchUrl: 'https://github.com/other/repo.git',
        pushUrl: 'git@github.com:other/repo.git',
      },
      {
        name: 'origin',
        fetchUrl: 'https://github.com/owner/repo.git',
        pushUrl: 'git@github.com:owner/push.git',
      },
    ];

    expect(selectGitCommitHoverRemote(remotes)).toEqual({
      name: 'origin',
      url: 'https://github.com/owner/repo.git',
    });
  });

  test('falls back to the push url when the fetch url is empty', () => {
    const remotes: GitRemote[] = [
      {
        name: 'fork',
        fetchUrl: '',
        pushUrl: 'git@github.com:owner/repo.git',
      },
    ];

    expect(selectGitCommitHoverRemote(remotes)).toEqual({
      name: 'fork',
      url: 'git@github.com:owner/repo.git',
    });
  });

  test('returns null when no remote has a usable url', () => {
    expect(selectGitCommitHoverRemote([{ name: 'origin', fetchUrl: '', pushUrl: '' }])).toBeNull();
  });
});

describe('buildGitHubCommitUrl', () => {
  test('builds commit urls from https, ssh scp, and ssh scheme remotes', () => {
    const hash = 'd'.repeat(40);
    expect(buildGitHubCommitUrl('https://github.com/owner/repo.git', hash)).toBe(`https://github.com/owner/repo/commit/${hash}`);
    expect(buildGitHubCommitUrl('git@github.com:owner/repo.git', hash)).toBe(`https://github.com/owner/repo/commit/${hash}`);
    expect(buildGitHubCommitUrl('ssh://git@github.com/owner/repo.git', hash)).toBe(`https://github.com/owner/repo/commit/${hash}`);
  });

  test('returns null for malformed, non-github, or non-hex inputs', () => {
    const hash = 'd'.repeat(40);
    expect(buildGitHubCommitUrl(undefined, hash)).toBeNull();
    expect(buildGitHubCommitUrl('https://example.com/owner/repo.git', hash)).toBeNull();
    expect(buildGitHubCommitUrl('git@github.com:owner.git', hash)).toBeNull();
    expect(buildGitHubCommitUrl('https://github.com/owner/repo.git', 'not-hex')).toBeNull();
  });
});
