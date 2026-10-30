import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createSshHostResolver, isSshHostName, sshHostReaches, sshUserOf } from './ssh-host-alias.js';
import { resolveGiteaReposFromDirectory } from '../gitea/repo.js';

describe('SSH host aliases', () => {
  it('accepts plain host names only, so nothing reaches ssh as an option', () => {
    expect(isSshHostName('forgejo')).toBe(true);
    expect(isSshHostName('git.example.com')).toBe(true);
    expect(isSshHostName('-oProxyCommand=curl example.com')).toBe(false);
    expect(isSshHostName('forgejo host')).toBe(false);
    expect(isSshHostName('')).toBe(false);
    expect(isSshHostName(null)).toBe(false);
  });

  it('answers the host name the SSH configuration resolves a host to, once per minute', async () => {
    const read = vi.fn(async () => ({ hostname: 'git.example.com', hostKeyAlias: null }));
    const resolve = createSshHostResolver({ read });

    await expect(resolve('forgejo')).resolves.toEqual({ hostname: 'git.example.com', hostKeyAlias: null });
    await expect(resolve('FORGEJO')).resolves.toEqual({ hostname: 'git.example.com', hostKeyAlias: null });
    expect(read).toHaveBeenCalledExactlyOnceWith('forgejo', '');
  });

  it.each([
    ['git@alias:owner/repo.git', 'git'],
    ['ssh://git@alias:2222/owner/repo.git', 'git'],
    ['git+ssh://G%69t@alias/owner/repo.git', 'Git'],
    ['alias:owner/repo.git', ''],
    ['ssh://alias/owner/repo.git', ''],
    ['ssh://g%it@alias/owner/repo.git', null],
  ])('preserves the explicit user of %s', (remote, user) => {
    expect(sshUserOf(remote)).toBe(user);
  });

  it('uses real SSH Match user rules and keeps users separate in the cache', async () => {
    const directory = await mkdtemp(path.join(process.cwd(), '.ssh-host-alias-test-'));
    try {
      const configFile = path.join(directory, 'config');
      await writeFile(configFile, [
        'Host *',
        '  User deploy',
        'Match user git',
        '  HostName other.example.com',
        'Host alias',
        '  HostName git.example.com',
        '',
      ].join('\n'));
      const resolve = createSshHostResolver({ configFile });
      await expect(sshHostReaches('alias', 'git.example.com', '', resolve)).resolves.toBe(true);
      await expect(sshHostReaches('alias', 'git.example.com', sshUserOf('git@alias:owner/repo.git'), resolve)).resolves.toBe(false);
      await expect(resolve('alias', 'git')).resolves.toEqual({ hostname: 'other.example.com' });
      await expect(sshHostReaches('alias', 'git.example.com', 'Git', resolve)).resolves.toBe(true);
      await expect(sshHostReaches('alias', 'other.example.com', 'git', resolve)).resolves.toBe(true);
      const resolved = await resolveGiteaReposFromDirectory('/repo', 'https://git.example.com', '', {
        getRemotes: async () => [
          { name: 'origin', fetchUrl: 'deploy@alias:owner/repo.git', pushUrl: 'git@alias:other/repo.git' },
          { name: 'other', fetchUrl: 'ssh://git@alias/other/repo.git' },
        ],
        getStatus: async () => ({}),
        sshHostReaches: (host, hostname, user) => sshHostReaches(host, hostname, user, resolve),
      });
      expect(resolved.repos.map((repo) => [repo.remoteName, repo.repoPath])).toEqual([['origin', 'owner/repo']]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('answers null when ssh cannot read the host, and does not ask again right away', async () => {
    const read = vi.fn(async () => null);
    const resolve = createSshHostResolver({ read });

    await expect(resolve('missing')).resolves.toBeNull();
    await expect(resolve('missing')).resolves.toBeNull();
    expect(read).toHaveBeenCalledOnce();
  });

  it('shares a cold read across concurrent callers', async () => {
    let finish;
    const read = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const resolve = createSshHostResolver({ read });
    const first = resolve('forgejo');
    const second = resolve('FORGEJO');

    await Promise.resolve();
    expect(read).toHaveBeenCalledOnce();
    finish({ hostname: 'git.example.com' });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { hostname: 'git.example.com' }, { hostname: 'git.example.com' },
    ]);
  });

  it.each([null, { hostname: 'git.example.com' }])('expires a completed answer after a minute: %s', async (answer) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      const read = vi.fn(async () => answer);
      const resolve = createSshHostResolver({ read });
      await expect(resolve('forgejo')).resolves.toEqual(answer);
      clock.mockReturnValue(59_999);
      await expect(resolve('forgejo')).resolves.toEqual(answer);
      expect(read).toHaveBeenCalledOnce();
      clock.mockReturnValue(60_000);
      await expect(resolve('forgejo')).resolves.toEqual(answer);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('evicts old hosts at the cache limit', async () => {
    const read = vi.fn(async (hostname) => ({ hostname }));
    const resolve = createSshHostResolver({ read });
    for (let index = 0; index < 257; index += 1) await resolve(`host-${index}`);
    await resolve('host-256');
    expect(read).toHaveBeenCalledTimes(257);
    await resolve('host-0');
    expect(read).toHaveBeenCalledTimes(258);
  });

  it('asks nothing about a value that is not a host name', async () => {
    const read = vi.fn(async () => ({ hostname: 'git.example.com', hostKeyAlias: null }));
    const resolve = createSshHostResolver({ read });

    await expect(resolve('-oProxyCommand=touch /tmp/pwned')).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});

describe('SSH hosts reaching an instance', () => {
  const resolver = (hosts) => vi.fn(async (host) => hosts[host] ?? { hostname: host, hostKeyAlias: null });

  it('matches an alias that resolves to the instance host name', async () => {
    const resolve = resolver({ forgejo: { hostname: 'git.example.com', hostKeyAlias: null } });

    await expect(sshHostReaches('forgejo', 'git.example.com', '', resolve)).resolves.toBe(true);
  });

  it('refuses an alias whose only match is its host key alias', async () => {
    const resolve = resolver({ forgejo: { hostname: '10.0.0.4', hostKeyAlias: 'git.example.com' } });

    await expect(sshHostReaches('forgejo', 'git.example.com', '', resolve)).resolves.toBe(false);
  });

  it('refuses separate services sharing an IP address', async () => {
    const resolve = resolver({
      forgejo: { hostname: '10.0.0.4', port: 2222 },
      'git.example.com': { hostname: '10.0.0.4', port: 22 },
    });

    await expect(sshHostReaches('forgejo', 'git.example.com', '', resolve)).resolves.toBe(false);
  });

  it('refuses an alias that reaches somewhere else', async () => {
    const resolve = resolver({
      forgejo: { hostname: '10.0.0.9', hostKeyAlias: null },
      'git.example.com': { hostname: '10.0.0.4', hostKeyAlias: null },
    });

    await expect(sshHostReaches('forgejo', 'git.example.com', '', resolve)).resolves.toBe(false);
    await expect(sshHostReaches('forgejo', 'git.example.com', '', async () => null)).resolves.toBe(false);
  });
});
