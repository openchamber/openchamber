import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSourceControlAuthStore } from './auth-storage.js';

const execFileAsync = promisify(execFile);
const authStorageModuleUrl = pathToFileURL(path.resolve(import.meta.dirname, 'auth-storage.js')).href;
const directories = [];
const makeStore = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-gitlab-auth-'));
  directories.push(directory);
  const filePath = path.join(directory, 'source-control-auth.json');
  return { directory, filePath, store: createSourceControlAuthStore({ filePath }) };
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('source-control auth storage', () => {
  it('round trips distinct OAuth and PAT credentials for the same provider user', async () => {
    const { store } = await makeStore();
    const origin = 'https://gitlab.example.com';
    const pat = await store.setAccount(origin, { token: 'one', user: { id: 1, login: 'old-login' }, source: 'pat' });
    const oauth = await store.setAccount(origin, { token: 'two', user: { id: 1, login: 'new-login' }, source: 'oauth', scope: 'api' });

    expect(pat.id).not.toBe(oauth.id);
    expect(pat.providerUserId).toBe(`${origin}#1`);
    expect(oauth.providerUserId).toBe(pat.providerUserId);
    expect((await store.readInstance(origin)).activeAccountId).toBe(oauth.id);
    await expect(store.readAccount(origin, pat.id, pat.credentialRevision)).resolves.toMatchObject({ token: 'one' });
    await expect(store.readAccount(origin, oauth.id, oauth.credentialRevision)).resolves.toMatchObject({ token: 'two' });
    await expect(store.readAccount(origin, oauth.id, oauth.credentialRevision + 1)).resolves.toBeNull();
    await expect(store.listAccounts(origin)).resolves.toHaveLength(2);
  });

  it('targets one credential and keeps its provider user available while a sibling remains valid', async () => {
    const { store } = await makeStore();
    const origin = 'https://gitlab.example.com';
    const first = await store.setAccount(origin, { token: 'one', user: { id: 1, login: 'one' }, source: 'pat' });
    const second = await store.setAccount(origin, { token: 'two', user: { id: 1, login: 'one' }, source: 'oauth' });

    await expect(store.markAccountInvalid(origin, first.id, 'unauthorized')).resolves.toBe(true);
    await expect(store.readAccount(origin, first.id)).resolves.toBeNull();
    await expect(store.readAccount(origin, second.id)).resolves.toMatchObject({ token: 'two' });
    await expect(store.removeAccount(origin, first.id)).resolves.toBe(true);
    await expect(store.removeAccount(origin, first.id)).resolves.toBe(false);
  });

  it('keeps account selection independent across instances', async () => {
    const { store } = await makeStore();
    const firstOrigin = 'https://gitlab.com';
    const secondOrigin = 'https://gitlab.example.com';
    const first = await store.setAccount(firstOrigin, { token: 'first', user: { id: 1, login: 'first' }, source: 'pat' });
    const second = await store.setAccount(secondOrigin, { token: 'second', user: { id: 2, login: 'second' }, source: 'oauth' });

    await expect(store.listInstances()).resolves.toEqual([firstOrigin, secondOrigin]);
    await expect(store.readInstance(firstOrigin)).resolves.toMatchObject({ activeAccountId: first.id });
    await expect(store.readInstance(secondOrigin)).resolves.toMatchObject({ activeAccountId: second.id });
  });

  it('reads a version 2 GitLab-only file without rewriting it, and moves to version 3 with the first GitHub Enterprise credential', async () => {
    const { directory, filePath, store } = await makeStore();
    const origin = 'https://gitlab.example.com';
    await fs.writeFile(filePath, JSON.stringify({
      version: 2,
      providers: { gitlab: { instances: { [origin]: {
        activeCredentialId: 'cred-1',
        credentials: [
          { credentialId: 'cred-1', revision: 1, providerUserId: `${origin}#1`, token: 'glpat-1', user: { id: 1, login: 'one' }, source: 'pat', scope: 'api', status: 'valid' },
        ],
        cliDisabled: false,
        cliActive: true,
      } } } },
    }), 'utf8');

    await expect(store.readInstance(origin)).resolves.toMatchObject({ activeAccountId: 'cred-1' });
    // Earlier releases read only version 2, so the file stays as it was.
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toMatchObject({ version: 2 });

    await store.github.setAccount('ghe.example.com', { accessToken: 'github-pat', user: { id: 42, login: 'ghe-user' }, source: 'pat', scope: 'repo' });
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toMatchObject({
      version: 3,
      providers: {
        gitlab: { instances: { [origin]: { activeCredentialId: 'cred-1' } } },
        github: { instances: { 'ghe.example.com': expect.objectContaining({ activeCredentialId: expect.any(String) }) } },
      },
    });
  });

  it('round trips a GitHub Enterprise personal access token per host in the github section', async () => {
    const { store } = await makeStore();
    const host = 'ghe.example.com';
    const credential = await store.github.setAccount(host, { accessToken: 'github-pat', user: { id: 42, login: 'ghe-user' }, source: 'pat', scope: 'repo' });

    expect(credential).toMatchObject({
      credentialId: credential.id,
      accountId: credential.id,
      credentialRevision: 1,
      providerUserId: `${host}#42`,
      accessToken: 'github-pat',
      source: 'pat',
      status: 'valid',
    });
    await expect(store.github.listInstances()).resolves.toEqual([host]);
    await expect(store.github.readAccount(host, credential.id, credential.credentialRevision)).resolves.toMatchObject({ accessToken: 'github-pat' });
    await expect(store.github.readAccount('other.example.com', credential.id)).resolves.toBeNull();
    await expect(store.github.readAccountAnyInstance(credential.id)).resolves.toMatchObject({ accessToken: 'github-pat', host });
  });

  it('keeps GitHub Enterprise hosts apart from GitLab origins in the same file', async () => {
    const { store } = await makeStore();
    const host = 'ghe.example.com';
    const credential = await store.github.setAccount(host, { accessToken: 'pat', user: { id: 1, login: 'one' }, source: 'pat' });
    await store.setAccount('https://gitlab.example.com', { token: 'glpat', user: { id: 1, login: 'one' }, source: 'pat' });

    await expect(store.github.listAccounts(host)).resolves.toHaveLength(1);
    await expect(store.listInstances()).resolves.toEqual(['https://gitlab.example.com']);
    await expect(store.github.readAccount('https://gitlab.example.com', credential.id)).resolves.toBeNull();
    await expect(store.github.readAccountAnyInstance(credential.id)).resolves.toMatchObject({ accessToken: 'pat', host });
  });

  it('targets one GitHub Enterprise credential while a sibling remains valid and keeps the host gh switch per host', async () => {
    const { store } = await makeStore();
    const host = 'ghe.example.com';
    const first = await store.github.setAccount(host, { accessToken: 'one', user: { id: 1, login: 'one' }, source: 'pat' });
    const second = await store.github.setAccount(host, { accessToken: 'two', user: { id: 2, login: 'two' }, source: 'pat' });

    await expect(store.github.readAccount(host, first.id)).resolves.toMatchObject({ accessToken: 'one' });
    await expect(store.github.markAccountInvalid(host, first.id, 'unauthorized')).resolves.toBe(true);
    await expect(store.github.readAccount(host, first.id)).resolves.toBeNull();
    await expect(store.github.readAccount(host, second.id)).resolves.toMatchObject({ accessToken: 'two' });
    await expect(store.github.removeAccount(host, first.id)).resolves.toBe(false);
    await expect(store.github.setCliActive(host, true)).resolves.toBe(true);
    await expect(store.github.readInstance(host)).resolves.toMatchObject({ cliActive: true });
    await expect(store.github.setCliDisabled(host, true)).resolves.toBe(true);
    await expect(store.github.readInstance(host)).resolves.toMatchObject({ cliActive: false, cliDisabled: true });
    await expect(store.github.setCliActive(host, true)).resolves.toBe(false);
  });

  it('writes version 2 and 3 exactly as before while no extra provider section holds anything', async () => {
    const { filePath, store } = await makeStore();
    const origin = 'https://gitlab.example.com';
    const gitlab = await store.setAccount(origin, { token: 'glpat', user: { id: 1, login: 'one' }, source: 'pat' });
    const written = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(written).toEqual({ version: 2, providers: { gitlab: { instances: { [origin]: {
      activeCredentialId: gitlab.id,
      credentials: [{
        credentialId: gitlab.id, revision: 1, providerUserId: `${origin}#1`, token: 'glpat',
        user: { id: 1, login: 'one' }, source: 'pat', scope: '', status: 'valid',
      }],
      cliDisabled: false,
      cliActive: false,
    } } } } });
    expect(gitlab.id).toMatch(/^occred:v1:gitlab:[0-9a-f-]+:r1$/);

    await store.github.setAccount('ghe.example.com', { accessToken: 'pat', user: { id: 2, login: 'two' }, source: 'pat' });
    expect(Object.keys(JSON.parse(await fs.readFile(filePath, 'utf8')).providers)).toEqual(['gitlab', 'github']);
    expect(JSON.parse(await fs.readFile(filePath, 'utf8')).version).toBe(3);

    // An extra section that is touched but stays empty writes no version 4.
    await store.section('gitea').setCliDisabled('https://gitea.example.com', false);
    expect(JSON.parse(await fs.readFile(filePath, 'utf8')).version).toBe(3);
  });

  it('writes version 4 only while an extra provider section holds something, and goes back when it empties', async () => {
    const { filePath, store } = await makeStore();
    const origin = 'https://gitea.example.com';
    const gitea = store.section('gitea');
    const credential = await gitea.setAccount(origin, { token: 'gitea-pat', user: { id: 5, login: 'five' }, source: 'pat' });

    expect(credential).toMatchObject({ providerUserId: `${origin}#5`, token: 'gitea-pat', credentialRevision: 1 });
    expect(credential.id).toMatch(/^occred:v1:gitea:[0-9a-f-]+:r1$/);
    const written = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(written.version).toBe(4);
    expect(Object.keys(written.providers)).toEqual(['gitlab', 'github', 'gitea']);
    await expect(store.listInstances()).resolves.toEqual([]);
    await expect(gitea.readAccount(origin, credential.id, 1)).resolves.toMatchObject({ token: 'gitea-pat' });
    await expect(createSourceControlAuthStore({ filePath }).section('gitea').listInstances()).resolves.toEqual([origin]);

    await gitea.removeAccount(origin, credential.id);
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toEqual({ version: 2, providers: { gitlab: { instances: {} } } });
    expect(() => store.section('github')).toThrow();
    expect(() => store.section('Not An Id')).toThrow();
  });

  it('drops an extension provider section in one write and refuses built-in sections', async () => {
    const { filePath, store } = await makeStore();
    const origin = 'https://forge.example.com';
    const forge = store.section('ext-forge');
    await forge.setAccount(origin, { token: 'forge-pat', user: { id: 5, login: 'five' }, source: 'pat' });
    await forge.setAccount('https://other.example.com', { token: 'other-pat', user: { id: 6, login: 'six' }, source: 'pat' });
    const gitea = await store.section('gitea').setAccount(origin, { token: 'gitea-pat', user: { id: 5, login: 'five' }, source: 'pat' });

    await expect(store.dropSection('ext-forge')).resolves.toBe(true);
    const written = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(Object.keys(written.providers)).toEqual(['gitlab', 'github', 'gitea']);
    await expect(forge.listInstances()).resolves.toEqual([]);
    await expect(store.section('gitea').readAccount(origin, gitea.id)).resolves.toMatchObject({ token: 'gitea-pat' });
    await expect(store.dropSection('ext-forge')).resolves.toBe(false);

    for (const id of ['gitlab', 'github', 'gitea', 'ext-', 'Not An Id']) {
      await expect(store.dropSection(id)).rejects.toThrow(/cannot be dropped/);
    }
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toEqual(written);
  });

  it('drops an extension section this build cannot parse', async () => {
    const { filePath, store } = await makeStore();
    await fs.writeFile(filePath, JSON.stringify({
      version: 4,
      providers: { gitlab: { instances: {} }, github: { instances: {} }, 'ext-forge': { instances: { 'not an origin': {} } } },
    }), 'utf8');

    await expect(store.dropSection('ext-forge')).resolves.toBe(true);
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toEqual({ version: 2, providers: { gitlab: { instances: {} } } });
  });

  it('round trips a section of a provider this build does not know, byte for byte', async () => {
    const { filePath, store } = await makeStore();
    const forgeOrigin = 'https://forge.example.com';
    const unknown = {
      version: 4,
      providers: {
        gitlab: { instances: {} },
        github: { instances: {} },
        forgejo: { instances: { [forgeOrigin]: {
          activeCredentialId: 'occred:v1:forgejo:one:r1',
          credentials: [{
            credentialId: 'occred:v1:forgejo:one:r1', revision: 1, providerUserId: `${forgeOrigin}#3`, token: 'forge-pat',
            user: { id: 3, login: 'three' }, source: 'pat', scope: '', status: 'valid',
          }],
          cliDisabled: false,
          cliActive: false,
        } } },
      },
    };
    await fs.writeFile(filePath, JSON.stringify(unknown), 'utf8');

    const gitlab = await store.setAccount('https://gitlab.example.com', { token: 'glpat', user: { id: 1, login: 'one' }, source: 'pat' });
    const written = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(written.version).toBe(4);
    expect(written.providers.forgejo).toEqual(unknown.providers.forgejo);
    await store.removeAccount('https://gitlab.example.com', gitlab.id);
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toEqual(unknown);
  });

  it('keeps a section of another build that does not parse here, and fails only that provider', async () => {
    const { filePath, store } = await makeStore();
    const original = {
      version: 4,
      providers: {
        gitlab: { instances: {} },
        github: { instances: {} },
        // A newer build's provider keyed by bare host, with a credential field this build does not know.
        bitbucket: { instances: { 'bitbucket.org': { credentials: [{ credentialId: 'x', workspace: 'w' }] } } },
        // A section this build owns but cannot read.
        gitea: { instances: { 'not an origin': {} } },
      },
    };
    await fs.writeFile(filePath, JSON.stringify(original), 'utf8');

    const origin = 'https://gitlab.example.com';
    const gitlab = await store.setAccount(origin, { token: 'glpat', user: { id: 1, login: 'one' }, source: 'pat' });
    await expect(store.github.listInstances()).resolves.toEqual([]);
    await expect(store.section('gitea').listInstances()).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_AUTH' });
    const written = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(written.providers.bitbucket).toEqual(original.providers.bitbucket);
    expect(written.providers.gitea).toEqual(original.providers.gitea);
    await store.removeAccount(origin, gitlab.id);
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toEqual(original);
  });

  it('refuses a version 3 file with an extra section and a version 4 file with an invalid id or a missing built-in section', async () => {
    const { filePath, store } = await makeStore();
    const section = { instances: {} };
    for (const value of [
      { version: 3, providers: { gitlab: section, github: section, gitea: section } },
      { version: 4, providers: { gitlab: section, github: section, 'Not An Id': section } },
      { version: 4, providers: { gitlab: section, gitea: section } },
      { version: 5, providers: { gitlab: section, github: section } },
    ]) {
      await fs.writeFile(filePath, JSON.stringify(value), 'utf8');
      await expect(store.listInstances()).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_AUTH' });
      expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toEqual(value);
    }
  });

  it('treats missing files as empty and rejects malformed or unsupported files without rewriting them', async () => {
    const { filePath, store } = await makeStore();
    await expect(store.readInstance('https://gitlab.com')).resolves.toEqual({ activeAccountId: null, accounts: [], cliDisabled: false, cliActive: false });
    await fs.writeFile(filePath, '{broken', 'utf8');
    await expect(store.readInstance('https://gitlab.com')).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_AUTH' });
    await expect(store.setAccount('https://gitlab.com', { token: 'secret', user: { id: 1, login: 'user' }, source: 'pat' }))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_AUTH' });
    expect(await fs.readFile(filePath, 'utf8')).toBe('{broken');

    await fs.writeFile(filePath, JSON.stringify({ version: 3, providers: { gitlab: { instances: {} } } }), 'utf8');
    await expect(store.readInstance('https://gitlab.com')).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_AUTH' });
  });

  it('serializes complete transactions across independent store instances', async () => {
    const { directory, filePath } = await makeStore();
    const origin = 'https://gitlab.example.com';
    const first = createSourceControlAuthStore({ filePath });
    const second = createSourceControlAuthStore({ filePath });
    await Promise.all([
      first.setAccount(origin, { token: 'one', user: { id: 1, login: 'one' }, source: 'pat' }),
      second.setAccount(origin, { token: 'two', user: { id: 2, login: 'two' }, source: 'oauth' }),
    ]);

    await expect(first.listAccounts(origin)).resolves.toHaveLength(2);
    expect((await fs.readdir(directory)).filter((name) => name.endsWith('.lock') || name.endsWith('.tmp'))).toEqual([]);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it('does not lose concurrent credentials written by separate processes', async () => {
    const { directory, filePath, store } = await makeStore();
    const origin = 'https://gitlab.example.com';
    const worker = ({ token, id, login, source }) => `
      import(${JSON.stringify(authStorageModuleUrl)}).then(async ({ createSourceControlAuthStore }) => {
        const store = createSourceControlAuthStore({ filePath: ${JSON.stringify(filePath)} });
        await store.setAccount(${JSON.stringify(origin)}, { token: ${JSON.stringify(token)}, user: { id: ${id}, login: ${JSON.stringify(login)} }, source: ${JSON.stringify(source)} });
      }).catch((error) => { console.error(error); process.exitCode = 1; });
    `;

    await Promise.all([
      execFileAsync(process.execPath, ['-e', worker({ token: 'one', id: 1, login: 'one', source: 'pat' })]),
      execFileAsync(process.execPath, ['-e', worker({ token: 'two', id: 2, login: 'two', source: 'oauth' })]),
    ]);

    await expect(store.listAccounts(origin)).resolves.toHaveLength(2);
    expect((await fs.readdir(directory)).filter((name) => name.endsWith('.lock') || name.endsWith('.tmp'))).toEqual([]);
  });

  describe('OAuth renewal', () => {
    const origin = 'https://gitlab.com';
    const user = { id: 7, login: 'person' };
    const renewingStore = async (refreshOAuthToken, clock) => {
      const { filePath } = await makeStore();
      return createSourceControlAuthStore({ filePath, refreshOAuthToken, now: () => clock.now });
    };

    it('renews an expiring token once for concurrent readers and keeps the credential id and revision', async () => {
      const clock = { now: 1_000_000 };
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const refresh = vi.fn(async () => { await gate; return { accessToken: 'fresh', refreshToken: 'refresh-2', expiresIn: 7200 }; });
      const store = await renewingStore(refresh, clock);
      const account = await store.setAccount(origin, { token: 'stale', user, source: 'oauth', scope: 'api', refreshToken: 'refresh-1', expiresIn: 7200 });

      await expect(store.readAccount(origin, account.id, account.credentialRevision)).resolves.toMatchObject({ token: 'stale' });
      expect(refresh).not.toHaveBeenCalled();

      clock.now += (7200 - 60) * 1000;
      const readers = [store.readAccount(origin, account.id, account.credentialRevision), store.readInstance(origin)];
      release();
      const [renewed, instance] = await Promise.all(readers);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledWith({ provider: 'gitlab', origin, refreshToken: 'refresh-1' });
      expect(renewed).toMatchObject({ id: account.id, credentialRevision: account.credentialRevision, token: 'fresh', refreshToken: 'refresh-2' });
      expect(instance.accounts[0]).toMatchObject({ token: 'fresh', expiresAt: clock.now + 7200 * 1000 });
    });

    it('leaves the credential alone when GitLab refuses the refresh, and personal tokens are never renewed', async () => {
      const clock = { now: 1_000_000 };
      const refresh = vi.fn(async () => { throw Object.assign(new Error('invalid_grant'), { kind: 'invalid-token' }); });
      const store = await renewingStore(refresh, clock);
      const oauth = await store.setAccount(origin, { token: 'stale', user, source: 'oauth', refreshToken: 'refresh-1', expiresIn: 60 });
      const pat = await store.setAccount(origin, { token: 'pat', user, source: 'pat', refreshToken: 'ignored', expiresIn: 60 });

      await expect(store.readAccount(origin, oauth.id)).resolves.toMatchObject({ token: 'stale', status: 'valid' });
      await expect(store.renewAccount(origin, oauth.id)).resolves.toBe(false);
      await expect(store.renewAccount(origin, pat.id)).resolves.toBe(false);
      expect(pat.refreshToken).toBeUndefined();
      expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('never spends one refresh token twice when two processes share the file', async () => {
      const clock = { now: 1_000_000 };
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const refresh = vi.fn(async () => { await gate; return { accessToken: 'fresh', refreshToken: 'refresh-2', expiresIn: 7200 }; });
      const { filePath } = await makeStore();
      const desktop = createSourceControlAuthStore({ filePath, refreshOAuthToken: refresh, now: () => clock.now });
      const server = createSourceControlAuthStore({ filePath, refreshOAuthToken: refresh, now: () => clock.now });
      const account = await desktop.setAccount(origin, { token: 'stale', user, source: 'oauth', refreshToken: 'refresh-1', expiresIn: 60 });

      const desktopRead = desktop.readAccount(origin, account.id);
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
      const serverRead = server.readAccount(origin, account.id);
      const serverRenewal = server.renewAccount(origin, account.id);
      // Both server calls have read the old refresh token and wait on the renewal lock.
      await new Promise((resolve) => { setTimeout(resolve, 100); });
      release();

      await expect(desktopRead).resolves.toMatchObject({ token: 'fresh', refreshToken: 'refresh-2' });
      await expect(serverRead).resolves.toMatchObject({ token: 'fresh', refreshToken: 'refresh-2' });
      await expect(serverRenewal).resolves.toBe(true);
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('renews on demand after a refused request and survives a reload', async () => {
      const clock = { now: 1_000_000 };
      const refresh = vi.fn(async () => ({ accessToken: 'fresh', refreshToken: 'refresh-2', expiresIn: 7200 }));
      const { filePath } = await makeStore();
      const store = createSourceControlAuthStore({ filePath, refreshOAuthToken: refresh, now: () => clock.now });
      const account = await store.setAccount(origin, { token: 'stale', user, source: 'oauth', refreshToken: 'refresh-1', expiresIn: 7200 });

      await expect(store.renewAccount(origin, account.id)).resolves.toBe(true);
      const reloaded = createSourceControlAuthStore({ filePath });
      await expect(reloaded.readAccount(origin, account.id, account.credentialRevision))
        .resolves.toMatchObject({ token: 'fresh', refreshToken: 'refresh-2' });
    });
  });
});

