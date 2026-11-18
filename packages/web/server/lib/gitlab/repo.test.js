import { describe, expect, it, vi } from 'vitest';
import { parseGitLabRemoteUrl, rankGitLabRemotes, resolveGitLabProjectsFromDirectory } from './repo.js';

describe('GitLab repository resolution', () => {
  it('parses nested namespaces for supported remote forms', () => {
    const instance = 'https://gitlab.example.com';
    expect(parseGitLabRemoteUrl('git@gitlab.example.com:group/team/repo.git', instance)).toEqual({
      projectPath: 'group/team/repo', url: 'https://gitlab.example.com/group/team/repo',
    });
    expect(parseGitLabRemoteUrl('ssh://git@gitlab.example.com/group/team/repo.git', instance)?.projectPath).toBe('group/team/repo');
    expect(parseGitLabRemoteUrl('ssh://git@gitlab.example.com:2224/group/team/repo.git', instance)?.projectPath).toBe('group/team/repo');
    expect(parseGitLabRemoteUrl('https://gitlab.example.com/group/team/repo.git', instance)?.projectPath).toBe('group/team/repo');
  });

  it('rejects another host, credentials, and malformed paths', () => {
    const instance = 'https://gitlab.example.com';
    expect(parseGitLabRemoteUrl('git@other.example.com:group/repo.git', instance)).toBeNull();
    expect(parseGitLabRemoteUrl('https://token@gitlab.example.com/group/repo.git', instance)).toBeNull();
    expect(parseGitLabRemoteUrl('https://gitlab.example.com/repo.git', instance)).toBeNull();
  });

  it('rejects non-primitive remote URLs without normalizing the instance', () => {
    for (const value of [undefined, null, 42, {}, Object('https://gitlab.com/team/repo.git')]) {
      expect(parseGitLabRemoteUrl(value, '')).toBeNull();
    }
  });

  it('accepts HTTP remotes only for an HTTP loopback instance', () => {
    expect(parseGitLabRemoteUrl('http://localhost:8929/group/repo.git', 'http://localhost:8929')).toEqual({
      projectPath: 'group/repo', url: 'http://localhost:8929/group/repo',
    });
    expect(parseGitLabRemoteUrl('http://token@localhost:8929/group/repo.git', 'http://localhost:8929')).toBeNull();
    expect(parseGitLabRemoteUrl('http://gitlab.example.com/group/repo.git', 'https://gitlab.example.com')).toBeNull();
  });

  it('ranks explicit and tracking remotes ahead of conventional names', () => {
    const remotes = [{ name: 'origin' }, { name: 'fork' }, { name: 'upstream' }, { name: 'mirror' }];
    expect(rankGitLabRemotes(remotes, 'mirror', 'fork/topic')).toEqual(['mirror', 'fork', 'origin', 'upstream']);
  });

  it('ignores non-string names and tracking while accepting Object member names', () => {
    expect(rankGitLabRemotes([{ name: 42 }, null, { name: 'constructor' }], Object('fork'), 42))
      .toEqual(['origin', 'upstream', 'constructor']);
  });

  it('keeps an explicitly undefined remote name in exact-remote results', async () => {
    const result = await resolveGitLabProjectsFromDirectory('/repo', 'gitlab.com', undefined, {
      exactRemote: true,
      getRemotes: async () => [{ fetchUrl: 'https://gitlab.com/team/repo.git', pushUrl: '' }],
    });
    expect(result).toEqual({
      branch: '',
      tracking: '',
      projects: [{ projectPath: 'team/repo', url: 'https://gitlab.com/team/repo', remoteName: undefined }],
    });
    expect(result.projects[0]).toHaveProperty('remoteName');
  });

  it('deduplicates projects while preserving the highest-ranked remote', async () => {
    const result = await resolveGitLabProjectsFromDirectory('/repo', 'gitlab.example.com', 'fork', {
      getStatus: async () => ({ current: 'topic', tracking: 'origin/topic' }),
      getRemotes: async () => [
        { name: 'origin', fetchUrl: 'git@gitlab.example.com:team/repo.git', pushUrl: 'git@gitlab.example.com:team/repo.git' },
        { name: 'fork', fetchUrl: 'git@gitlab.example.com:me/repo.git', pushUrl: 'git@gitlab.example.com:me/repo.git' },
        { name: 'mirror', fetchUrl: 'https://gitlab.example.com/team/repo.git', pushUrl: '' },
      ],
    });
    expect(result).toEqual({
      branch: 'topic', tracking: 'origin/topic', projects: [
        { projectPath: 'me/repo', url: 'https://gitlab.example.com/me/repo', remoteName: 'fork' },
        { projectPath: 'team/repo', url: 'https://gitlab.example.com/team/repo', remoteName: 'origin' },
      ],
    });
  });
});
