import { describe, expect, test } from 'bun:test';
import { detectGitProvider } from './gitProvider';

describe('detectGitProvider', () => {
  test('returns null with no remotes', () => {
    expect(detectGitProvider([], [])).toBeNull();
  });

  test('classifies github.com remotes across URL forms', () => {
    expect(detectGitProvider(['git@github.com:owner/repo.git'], [])).toBe('github');
    expect(detectGitProvider(['ssh://git@github.com/owner/repo.git'], [])).toBe('github');
    expect(detectGitProvider(['https://github.com/owner/repo.git'], [])).toBe('github');
  });

  test('classifies gitlab.com remotes across URL forms', () => {
    expect(detectGitProvider(['git@gitlab.com:group/project.git'], [])).toBe('gitlab');
    expect(detectGitProvider(['ssh://git@gitlab.com/group/sub/project.git'], [])).toBe('gitlab');
    expect(detectGitProvider(['https://gitlab.com/group/project'], [])).toBe('gitlab');
  });

  test('classifies a self-hosted GitLab remote through connected account hosts', () => {
    expect(detectGitProvider(['git@git.example.com:group/project.git'], ['https://git.example.com'])).toBe('gitlab');
    expect(detectGitProvider(['https://git.example.com/group/project.git'], ['https://git.example.com'])).toBe('gitlab');
  });

  test('does not classify an unknown self-hosted host as gitlab without an account', () => {
    expect(detectGitProvider(['git@git.example.com:group/project.git'], [])).toBe('other');
  });

  test('classifies other hosts as other', () => {
    expect(detectGitProvider(['git@gitea.example.com:owner/repo.git'], [])).toBe('other');
    expect(detectGitProvider(['https://bitbucket.org/owner/repo.git'], [])).toBe('other');
  });

  test('github wins when both github and gitlab remotes are present', () => {
    expect(detectGitProvider([
      'git@github.com:owner/repo.git',
      'git@gitlab.com:owner/repo.git',
    ], [])).toBe('github');
  });

  test('ignores malformed remotes', () => {
    expect(detectGitProvider(['', 'not a url', '   '], [])).toBeNull();
  });
});
