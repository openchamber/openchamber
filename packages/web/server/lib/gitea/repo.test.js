import { describe, expect, it } from 'vitest';
import { parseGiteaRemoteUrl, resolveGiteaReposFromDirectory } from './repo.js';

const origin = 'https://gitea.example.com:3000';

describe('Gitea remotes', () => {
  it.each([
    ['https://gitea.example.com:3000/alice/app.git', 'alice/app'],
    ['git@gitea.example.com:alice/app.git', 'alice/app'],
    ['ssh://git@gitea.example.com:2222/alice/app.git', 'alice/app'],
  ])('reads %s on the instance', (remote, path) => {
    expect(parseGiteaRemoteUrl(remote, origin)?.repoPath).toBe(path);
  });

  it.each([
    'https://gitea.example.com/alice/app.git',
    'https://elsewhere.example.com:3000/alice/app.git',
    'http://gitea.example.com:3000/alice/app.git',
    'https://gitea.example.com:3000/group/sub/app.git',
    'https://user:secret@gitea.example.com:3000/alice/app.git',
  ])('does not read %s as this instance', (remote) => {
    expect(parseGiteaRemoteUrl(remote, origin)).toBeNull();
  });

  it('reads plain HTTP only for a loopback instance', () => {
    expect(parseGiteaRemoteUrl('http://localhost:3000/alice/app.git', 'http://localhost:3000')?.repoPath).toBe('alice/app');
  });

  it('reads only the named remote when one is given', async () => {
    const remotes = [
      { name: 'origin', fetchUrl: `${origin}/alice/app.git` },
      { name: 'upstream', fetchUrl: `${origin}/team/app.git` },
    ];
    const resolved = await resolveGiteaReposFromDirectory('/repo', origin, 'upstream', { getRemotes: async () => remotes });
    expect(resolved.repos.map((repo) => repo.repoPath)).toEqual(['team/app']);
    const ranked = await resolveGiteaReposFromDirectory('/repo', origin, '', {
      getRemotes: async () => remotes, getStatus: async () => ({ tracking: 'upstream/main' }),
    });
    expect(ranked.repos.map((repo) => repo.remoteName)).toEqual(['upstream', 'origin']);
  });
});
