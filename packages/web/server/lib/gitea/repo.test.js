import { describe, expect, it, vi } from 'vitest';
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

  it.each(['', 'origin'])('reads an SSH alias with remote selection "%s"', async (explicitRemote) => {
    const remotes = [
      { name: 'origin', fetchUrl: 'forgejo:alice/app.git', pushUrl: 'forgejo:alice/app.git' },
      { name: 'elsewhere', fetchUrl: 'other:alice/app.git', pushUrl: 'other:alice/app.git' },
    ];
    const sshHostReaches = async (host, hostname) => host === 'forgejo' && hostname === 'gitea.example.com';
    const resolved = await resolveGiteaReposFromDirectory('/repo', origin, explicitRemote, {
      getRemotes: async () => remotes, getStatus: async () => ({}), sshHostReaches,
    });

    expect(resolved.repos.map((repo) => [repo.remoteName, repo.repoPath])).toEqual([['origin', 'alice/app']]);
    expect(parseGiteaRemoteUrl('forgejo:alice/app.git', origin)).toBeNull();
    expect(parseGiteaRemoteUrl('forgejo:alice/app.git', origin, { sshHosts: new Set(['forgejo:alice/app.git']) })?.repoPath).toBe('alice/app');
  });

  it.each(['git@forgejo:mallory/app.git', 'ssh://git@forgejo:2222/mallory/app.git', 'git+ssh://git@forgejo/mallory/app.git'])(
    'does not let another user on the same alias authorize %s', async (remoteUrl) => {
      const remotes = [
        { name: 'origin', fetchUrl: 'deploy@forgejo:alice/app.git', pushUrl: remoteUrl },
        { name: 'other', fetchUrl: remoteUrl },
      ];
      const sshHostReaches = vi.fn(async (_host, _hostname, user) => user === 'deploy');
      const resolved = await resolveGiteaReposFromDirectory('/repo', origin, '', {
        getRemotes: async () => remotes, getStatus: async () => ({}), sshHostReaches,
      });
      expect(resolved.repos.map((repo) => [repo.remoteName, repo.repoPath])).toEqual([['origin', 'alice/app']]);
      expect(sshHostReaches).toHaveBeenCalledWith('forgejo', 'gitea.example.com', 'git');
      expect(sshHostReaches).toHaveBeenCalledWith('forgejo', 'gitea.example.com', 'deploy');
    },
  );

  it('leaves remotes on the instance alone without reading the SSH configuration', async () => {
    const sshHostReaches = vi.fn(async () => false);
    const remotes = [
      { name: 'origin', fetchUrl: `${origin}/alice/app.git`, pushUrl: `${origin}/alice/app.git` },
      { name: 'elsewhere', fetchUrl: 'other:alice/app.git' },
    ];

    const resolved = await resolveGiteaReposFromDirectory('/repo', origin, 'origin', { getRemotes: async () => remotes, sshHostReaches });

    expect(resolved.repos.map((repo) => repo.repoPath)).toEqual(['alice/app']);
    expect(sshHostReaches).not.toHaveBeenCalled();
  });

  it('reads SSH remotes on the instance\'s separate SSH address', () => {
    const options = { sshUrl: 'ssh://git@giteassh.example.com:2222' };
    expect(parseGiteaRemoteUrl('ssh://git@giteassh.example.com:2222/alice/app.git', origin, options)?.repoPath).toBe('alice/app');
    expect(parseGiteaRemoteUrl('ssh://giteassh.example.com:2222/alice/app.git', origin, options)?.repoPath).toBe('alice/app');
    expect(parseGiteaRemoteUrl('git@giteassh.example.com:alice/app.git', origin, options)).toBeNull();
    expect(parseGiteaRemoteUrl('ssh://git@giteassh.example.com:2200/alice/app.git', origin, options)).toBeNull();
    expect(parseGiteaRemoteUrl('ssh://git@elsewhere.example.com:2222/alice/app.git', origin, options)).toBeNull();
    expect(parseGiteaRemoteUrl('ssh://git@giteassh.example.com/alice/app.git', origin, { sshUrl: 'ssh://giteassh.example.com' })?.repoPath).toBe('alice/app');
    expect(parseGiteaRemoteUrl('git@giteassh.example.com:alice/app.git', origin, { sshUrl: 'giteassh.example.com' })?.repoPath).toBe('alice/app');
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

  it('resolves a remote on the instance\'s separate SSH address', async () => {
    const sshHostReaches = vi.fn(async () => false);
    const remotes = [{ name: 'origin', fetchUrl: 'git@giteassh.example.com:alice/app.git' }];
    const resolved = await resolveGiteaReposFromDirectory('/repo', origin, '', {
      getRemotes: async () => remotes,
      getStatus: async () => ({ tracking: '' }),
      sshHostReaches,
      sshUrl: 'ssh://giteassh.example.com',
    });
    expect(resolved.repos).toEqual([expect.objectContaining({ repoPath: 'alice/app', remoteName: 'origin' })]);
    // The configured address matched on its own: the SSH configuration
    // resolves the split host to nothing and the remote still counts.
    expect(sshHostReaches).toHaveBeenCalledWith('giteassh.example.com', 'gitea.example.com', 'git');
  });
});
