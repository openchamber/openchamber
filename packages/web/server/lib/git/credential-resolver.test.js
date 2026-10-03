import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGitCredentialResolver,
  createHttpsCredentialReference,
  createSshCredentialReference,
  gitLfsCredentialEndpointAliases,
  normalizeGitRemoteEndpoint,
  parseGitCredentialReference,
} from './credential-resolver.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('Git credential resolver', () => {
  it('derives the git-lfs repository-path alias only from /info/lfs endpoints', () => {
    expect(gitLfsCredentialEndpointAliases({ protocol: 'https', host: 'github.com', port: 443, path: 'owner/repo.git/info/lfs' }))
      .toEqual([{ protocol: 'https', host: 'github.com', port: 443, path: 'owner/repo.git' }]);
    expect(gitLfsCredentialEndpointAliases({ protocol: 'https', host: 'lfs.example.com', port: 443, path: 'storage' })).toEqual([]);
    expect(gitLfsCredentialEndpointAliases({ protocol: 'https', host: 'lfs.example.com', port: 443, path: '/info/lfs' })).toEqual([]);
  });

  it('returns only an anonymous marker without credential lookup and rejects credential fields or SSH', async () => {
    const readGitHubAccount = vi.fn();
    const readGitLabAccount = vi.fn();
    const lookupManagedSshKey = vi.fn();
    const resolver = createGitCredentialResolver({ readGitHubAccount, readGitLabAccount, lookupManagedSshKey });
    const input = { mode: 'anonymous', endpoint: normalizeGitRemoteEndpoint('https://example.com/repo.git') };
    expect(await resolver.resolve(input)).toEqual({ mode: 'anonymous' });
    for (const extra of [{ credentialId: 'secret' }, { credentialId: undefined }, { credentialAccount: {} },
      { unverifiedConfirmed: true }, { endpoint: normalizeGitRemoteEndpoint('git@example.com:repo.git') }]) {
      await expect(resolver.resolve({ ...input, ...extra })).rejects.toThrow();
    }
    expect(readGitHubAccount).not.toHaveBeenCalled();
    expect(readGitLabAccount).not.toHaveBeenCalled();
    expect(lookupManagedSshKey).not.toHaveBeenCalled();
  });
  it('normalizes HTTPS, ssh URLs, and scp-style remotes to exact credential endpoints', () => {
    expect(normalizeGitRemoteEndpoint('https://Example.com:8443/group/repo.git')).toEqual({
      protocol: 'https', host: 'example.com', port: 8443, path: 'group/repo.git',
    });
    expect(normalizeGitRemoteEndpoint('ssh://git@Example.com:2222/group/repo.git')).toEqual({
      protocol: 'ssh', host: 'example.com', port: 2222, path: 'group/repo.git',
    });
    expect(normalizeGitRemoteEndpoint('git@Example.com:group/repo.git')).toEqual({
      protocol: 'ssh', host: 'example.com', port: 22, path: 'group/repo.git',
    });
  });

  it('round trips strict opaque references without treating the provider actor as the transport username', async () => {
    const reference = createHttpsCredentialReference({
      provider: 'gitlab',
      instance: 'https://gitlab.example.com',
      credentialId: 'account:transport/opaque',
      credentialRevision: 1,
      providerUserId: 'account:transport/opaque',
    });
    expect(parseGitCredentialReference(reference)).toEqual({
      version: 2,
      transport: 'https',
      provider: 'gitlab',
      instance: 'https://gitlab.example.com',
      credentialId: 'account:transport/opaque',
      credentialRevision: 1,
      providerUserId: 'account:transport/opaque',
    });

    const readGitLabAccount = vi.fn(async () => ({
      id: 'account:transport/opaque', credentialId: 'account:transport/opaque', revision: 1,
      credentialRevision: 1, providerUserId: 'account:transport/opaque', status: 'valid',
      token: 'secret-token', user: { username: 'provider-actor' },
    }));
    const resolver = createGitCredentialResolver({ readGitLabAccount });
    const snapshot = await resolver.resolve({
      mode: 'managed',
      credentialId: reference,
      endpoint: { protocol: 'https', host: 'GITLAB.EXAMPLE.COM:443', path: '/group/repository.git' },
    });

    expect(readGitLabAccount).toHaveBeenCalledWith('https://gitlab.example.com', 'account:transport/opaque', 1);
    expect(snapshot).toMatchObject({
      transport: 'https',
      username: 'oauth2',
      password: 'secret-token',
      actor: { login: 'provider-actor', accountId: 'account:transport/opaque' },
      allowedEndpoint: { protocol: 'https', host: 'gitlab.example.com', port: 443, path: 'group/repository.git' },
    });
    expect(snapshot.username).not.toBe(snapshot.actor.login);
  });

  it('round trips a versioned HTTPS reference and rejects a changed credential revision', async () => {
    const reference = createHttpsCredentialReference({
      provider: 'github',
      instance: 'github.com',
      credentialId: 'credential-one',
      credentialRevision: 3,
      providerUserId: 'github.com#42',
    });
    expect(parseGitCredentialReference(reference)).toEqual({
      version: 2,
      transport: 'https',
      provider: 'github',
      instance: 'github.com',
      credentialId: 'credential-one',
      credentialRevision: 3,
      providerUserId: 'github.com#42',
    });

    const readGitHubAccount = vi.fn(async (_credentialId, revision) => ({
      accountId: 'credential-one', credentialId: 'credential-one', credentialRevision: revision + 1,
      providerUserId: 'github.com#42', status: 'valid', accessToken: 'replacement-secret', user: { login: 'actor' },
    }));
    const resolver = createGitCredentialResolver({ readGitHubAccount });
    await expect(resolver.resolve({
      mode: 'managed',
      credentialId: reference,
      endpoint: { protocol: 'https', host: 'github.com', path: 'owner/repo.git' },
    })).rejects.toThrow('Managed provider account is unavailable');
    expect(readGitHubAccount).toHaveBeenCalledWith('credential-one', 3);
    expect(() => createHttpsCredentialReference({
      provider: 'github', instance: 'github.com', credentialId: 'credential-one', credentialRevision: 3,
    })).toThrow('reference value');
  });

  it('uses provider-user identity for a pinned credential actor without exposing the credential ID as an account', async () => {
    const reference = createHttpsCredentialReference({
      provider: 'github', instance: 'github.com', credentialId: 'credential-one',
      credentialRevision: 3, providerUserId: 'github.com#42',
    });
    const readGitHubAccount = vi.fn(async () => ({
      credentialId: 'credential-one', accountId: 'credential-one', credentialRevision: 3,
      providerUserId: 'github.com#42', status: 'valid', accessToken: 'secret', user: { login: 'actor' },
    }));
    const snapshot = await createGitCredentialResolver({ readGitHubAccount }).resolve({
      mode: 'managed', credentialId: reference,
      endpoint: { protocol: 'https', host: 'github.com', path: 'owner/repo.git' },
    });

    expect(snapshot.actor).toEqual({
      provider: 'github', instance: 'github.com', accountId: 'github.com#42', login: 'actor',
    });
    expect(JSON.stringify(snapshot.actor)).not.toContain('credential-one');
  });

  it('does not fall back to another account or permit an endpoint outside the reference instance', async () => {
    const readGitHubAccount = vi.fn(async () => null);
    const resolver = createGitCredentialResolver({ readGitHubAccount });
    const credentialId = createHttpsCredentialReference({
      provider: 'github', instance: 'github.com', credentialId: 'github.com#7', credentialRevision: 1, providerUserId: 'github.com#7',
    });
    const input = { mode: 'managed', credentialId, endpoint: { protocol: 'https', host: 'github.com', path: 'owner/repo.git' } };

    await expect(resolver.resolve(input)).rejects.toThrow('Managed provider account is unavailable');
    expect(readGitHubAccount).toHaveBeenCalledTimes(1);
    expect(readGitHubAccount).toHaveBeenCalledWith('github.com#7', 1);
    await expect(resolver.resolve({ ...input, endpoint: { ...input.endpoint, host: 'mirror.example.com' } }))
      .rejects.toThrow('outside the managed credential policy');
    await expect(resolver.resolve({
      ...input,
      credentialId: createHttpsCredentialReference({
        provider: 'github', instance: 'attacker.example', credentialId: 'github.com#7', credentialRevision: 1, providerUserId: 'github.com#7',
      }),
    })).rejects.toThrow('Invalid managed provider instance');
  });

  it('returns no credential for system mode', async () => {
    const resolver = createGitCredentialResolver();
    await expect(resolver.resolve({ mode: 'system' })).resolves.toEqual({ mode: 'system' });
  });

  it('realpaths and verifies an unencrypted managed SSH key fingerprint', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-git-key-'));
    temporaryDirectories.push(directory);
    const keyPath = path.join(directory, 'id_ed25519');
    await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);
    const { stdout } = await execFileAsync('ssh-keygen', ['-lf', `${keyPath}.pub`, '-E', 'sha256']);
    const fingerprint = stdout.match(/\bSHA256:[A-Za-z0-9+/]+={0,2}\b/)[0];
    const snapshotRoot = path.join(directory, 'snapshots');
    const lookupManagedSshKey = vi.fn(async () => ({ id: 'key-one', privateKeyPath: keyPath, fingerprint }));
    const resolver = createGitCredentialResolver({ lookupManagedSshKey, snapshotRoot });

    const snapshot = await resolver.resolve({
      mode: 'managed',
      credentialId: createSshCredentialReference('key-one'),
      endpoint: { protocol: 'ssh', host: 'git.example.com', path: 'owner/repo.git' },
      operationId: 'git_one',
    });
    expect(lookupManagedSshKey).toHaveBeenCalledWith('key-one');
    expect(snapshot).toMatchObject({
      mode: 'managed',
      transport: 'ssh',
      key: { sourcePath: await fs.realpath(keyPath), fingerprint },
      allowedEndpoint: { protocol: 'ssh', host: 'git.example.com', port: 22, path: 'owner/repo.git' },
    });
    expect(snapshot.key.privateKeyPath).toBe(path.join(snapshotRoot, 'git_one.key'));
    expect((await fs.stat(snapshot.key.privateKeyPath)).mode & 0o777).toBe(0o600);
    await snapshot.key.cleanup();
    await expect(fs.stat(snapshot.key.privateKeyPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects mismatched and encrypted SSH keys without trying another key', async () => {
    const executeFile = vi.fn(async () => ({ stdout: 'ssh-ed25519 public' }));
    executeFile.mockResolvedValueOnce({ stdout: 'ssh-ed25519 public' });
    executeFile.mockResolvedValueOnce({ stdout: `256 SHA256:${'d'.repeat(43)} comment (ED25519)` });
    const lookupManagedSshKey = vi.fn(async () => ({ id: 'only-key', privateKeyPath: '/keys/selected', fingerprint: `SHA256:${'s'.repeat(43)}` }));
    const sourceStats = { dev: 1n, ino: 2n, size: 64n, mode: 0o600n, mtimeNs: 3n, ctimeNs: 4n, isFile: () => true };
    const snapshotStats = { dev: 5, ino: 6 };
    const sourceHandle = { stat: vi.fn(async () => sourceStats), readFile: vi.fn(async () => Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nfixture')),
      close: vi.fn(async () => {}) };
    const snapshotHandle = { writeFile: vi.fn(async () => {}), stat: vi.fn(async () => snapshotStats), chmod: vi.fn(async () => {}),
      close: vi.fn(async () => {}) };
    const resolver = createGitCredentialResolver({
      lookupManagedSshKey,
      realpath: async (value) => value,
      executeFile,
      fsImpl: {
        mkdir: vi.fn(async () => {}),
        chmod: vi.fn(async () => {}),
        lstat: vi.fn(async () => ({ isDirectory: () => true, isSymbolicLink: () => false })),
        open: vi.fn(async (filePath) => filePath === '/keys/selected' ? sourceHandle : snapshotHandle),
        stat: vi.fn(async () => snapshotStats),
        rm: vi.fn(async () => {}),
      },
      snapshotRoot: '/snapshots',
    });
    const input = {
      mode: 'managed',
      credentialId: createSshCredentialReference('only-key'),
      endpoint: { protocol: 'ssh', host: 'git.example.com', path: 'owner/repo.git' },
      operationId: 'git_one',
    };
    await expect(resolver.resolve(input)).rejects.toThrow('fingerprint does not match');
    expect(lookupManagedSshKey).toHaveBeenCalledTimes(1);
    expect(executeFile).toHaveBeenNthCalledWith(1, 'ssh-keygen', ['-y', '-P', '', '-f', '/snapshots/git_one.key'], expect.any(Object));

    executeFile.mockReset();
    executeFile.mockRejectedValueOnce(new Error('passphrase required'));
    await expect(resolver.resolve(input)).rejects.toThrow('encrypted or unverifiable');
    expect(executeFile).toHaveBeenCalledTimes(1);
  });

  it('removes an owned SSH snapshot when mode hardening fails', async () => {
    const rm = vi.fn(async () => {});
    const sourceHandle = {
      stat: vi.fn(async () => ({ dev: 1n, ino: 2n, size: 64n, mode: 0o600n, mtimeNs: 3n, ctimeNs: 4n, isFile: () => true })),
      readFile: vi.fn(async () => Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nfixture')),
      close: vi.fn(async () => {}),
    };
    const snapshotHandle = {
      writeFile: vi.fn(async () => {}), stat: vi.fn(async () => ({ dev: 3, ino: 4 })),
      chmod: vi.fn(async () => { throw new Error('chmod failed'); }), close: vi.fn(async () => {}),
    };
    const resolver = createGitCredentialResolver({
      lookupManagedSshKey: async () => ({
        id: 'only-key', privateKeyPath: '/keys/source', fingerprint: `SHA256:${'s'.repeat(43)}`,
      }),
      realpath: async (value) => value,
      fsImpl: {
        mkdir: vi.fn(async () => {}),
        lstat: vi.fn(async () => ({ isDirectory: () => true, isSymbolicLink: () => false })),
        chmod: vi.fn(async () => {}),
        open: vi.fn(async (filePath) => filePath === '/keys/source' ? sourceHandle : snapshotHandle),
        stat: vi.fn(async () => ({ dev: 3, ino: 4 })),
        rm,
      },
      snapshotRoot: '/snapshots',
    });

    await expect(resolver.resolve({
      mode: 'managed',
      credentialId: createSshCredentialReference('only-key'),
      endpoint: { protocol: 'ssh', host: 'git.example.com', path: 'owner/repo.git' },
      operationId: 'git_one',
    })).rejects.toThrow('snapshot failed');
    expect(rm).toHaveBeenCalledWith('/snapshots/git_one.key', { force: true });
  });
});
