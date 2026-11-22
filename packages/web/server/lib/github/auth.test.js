import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);
const authModuleUrl = pathToFileURL(path.resolve(import.meta.dirname, 'auth.js')).href;
let directory;
let previousDataDirectory;
let auth;
let octokit;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-github-auth-'));
  previousDataDirectory = process.env.OPENCHAMBER_DATA_DIR;
  process.env.OPENCHAMBER_DATA_DIR = directory;
  vi.resetModules();
  auth = await import('./auth.js');
  octokit = await import('./octokit.js');
});

afterEach(async () => {
  if (previousDataDirectory === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousDataDirectory;
  vi.unstubAllGlobals();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('GitHub accounts from a vault', () => {
  const REFERENCE = 'op://Vertex SRE/github_token/credential';
  const user = { id: 42, login: 'octo' };

  it('stores only the reference and fills the token in when the account is read', async () => {
    const readSecret = vi.fn(async () => ({ ok: true, value: 'ghp_from_vault' }));
    auth.configureGitHubVaultReader(readSecret);
    const credential = await auth.setGitHubAuth({ tokenReference: REFERENCE, user, source: 'pat' });

    const stored = await fs.readFile(path.join(directory, 'github-auth.json'), 'utf8');
    expect(stored).toContain(REFERENCE);
    expect(stored).not.toContain('ghp_from_vault');
    expect(JSON.parse(stored).credentials[0]).not.toHaveProperty('accessToken');

    await expect(auth.getGitHubAuth()).resolves.toMatchObject({ accessToken: 'ghp_from_vault', tokenReference: REFERENCE });
    await expect(auth.getGitHubAuthByAccountId(credential.credentialId, credential.credentialRevision))
      .resolves.toMatchObject({ accessToken: 'ghp_from_vault' });
    expect(readSecret).toHaveBeenCalledWith(REFERENCE);
    const [account] = await auth.getGitHubAuthAccounts();
    expect(account).toMatchObject({ source: 'pat', tokenReference: REFERENCE });
    expect(JSON.stringify(account)).not.toContain('ghp_from_vault');
  });

  it('reads as an account without a token when the reference cannot be read', async () => {
    auth.configureGitHubVaultReader(async () => ({ ok: false, reason: 'op-not-installed' }));
    await auth.setGitHubAuth({ tokenReference: REFERENCE, user, source: 'pat' });
    const active = await auth.getGitHubAuth();
    expect(active).not.toHaveProperty('accessToken');
    expect(active.tokenReadError).toBe('op-not-installed');
  });

  // A refused vault token is most likely rotated there; marking it invalid
  // would keep the account off after the user fixes it.
  it('is not written off when GitHub refuses its token', async () => {
    auth.configureGitHubVaultReader(async () => ({ ok: true, value: 'ghp_old' }));
    const credential = await auth.setGitHubAuth({ tokenReference: REFERENCE, user, source: 'pat' });
    await auth.markGitHubAuthAccountInvalid(credential.credentialId);
    const [account] = await auth.getGitHubAuthAccounts();
    expect(account.status).toBe('valid');
  });

  it('refuses a reference that is not a vault reference, and a token and reference together', async () => {
    await expect(auth.setGitHubAuth({ tokenReference: 'ghp_plain', user, source: 'pat' })).rejects.toThrow();
    await expect(auth.setGitHubAuth({ tokenReference: REFERENCE, accessToken: 'x', user, source: 'pat' })).rejects.toThrow();
    await expect(auth.setGitHubAuth({ tokenReference: REFERENCE, user, source: 'oauth' })).rejects.toThrow();
  });
});

describe('GitHub auth credentials', () => {
  it('migrates the shipped array once while preserving the exact legacy credential ID and secret', async () => {
    const filePath = path.join(directory, 'github-auth.json');
    await fs.writeFile(filePath, JSON.stringify([
      { accessToken: 'old-secret', user: { id: 7, login: 'old-login' }, accountId: 'old-login', current: false, createdAt: 1 },
      { accessToken: 'new-secret', user: { id: 7, login: 'new-login' }, accountId: 'new-login', current: true, createdAt: 2 },
    ]), 'utf8');

    const accounts = await auth.getGitHubAuthAccounts();
    expect(accounts).toEqual([expect.objectContaining({
      id: 'github.com#7',
      credentialId: 'github.com#7',
      credentialRevision: 1,
      providerUserId: 'github.com#7',
      user: expect.objectContaining({ id: 7, login: 'new-login' }),
      source: 'oauth',
      status: 'valid',
    })]);
    await expect(auth.getGitHubAuthByAccountId('github.com#7', 1)).resolves.toMatchObject({ accessToken: 'new-secret' });
    const stored = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(stored).toMatchObject({ version: 2, activeCredentialId: 'github.com#7' });
    expect(stored.credentials).toEqual([expect.objectContaining({ credentialId: 'github.com#7', revision: 1, accessToken: 'new-secret' })]);
  });

  it('keeps OAuth and PAT credentials for one provider user distinct and immutable', async () => {
    const oauth = await auth.setGitHubAuth({ accessToken: 'oauth-secret', user: { id: 7, login: 'user' }, source: 'oauth' });
    const pat = await auth.setGitHubAuth({ accessToken: 'pat-secret', user: { id: 7, login: 'renamed' }, source: 'pat' });

    expect(oauth.accountId).not.toBe(pat.accountId);
    expect(oauth.providerUserId).toBe('github.com#7');
    expect(pat.providerUserId).toBe(oauth.providerUserId);
    await expect(auth.getGitHubAuthByAccountId(oauth.accountId, oauth.credentialRevision)).resolves.toMatchObject({ accessToken: 'oauth-secret' });
    await expect(auth.getGitHubAuthByAccountId(pat.accountId, pat.credentialRevision)).resolves.toMatchObject({ accessToken: 'pat-secret' });
    await expect(auth.getGitHubAuthByAccountId(pat.accountId, pat.credentialRevision + 1)).resolves.toBeNull();
    const inventory = await auth.getGitHubAuthAccounts();
    expect(inventory).toHaveLength(2);
    expect(new Set(inventory.map((entry) => entry.id)).size).toBe(2);
    expect(new Set(inventory.map((entry) => entry.providerUserId))).toEqual(new Set(['github.com#7']));
    expect(JSON.stringify(inventory)).not.toContain('secret');
  });

  it('targets invalidation and removal by exact credential while the provider user remains available', async () => {
    const oauth = await auth.setGitHubAuth({ accessToken: 'oauth', user: { id: 7, login: 'user' }, source: 'oauth' });
    const pat = await auth.setGitHubAuth({ accessToken: 'pat', user: { id: 7, login: 'user' }, source: 'pat' });

    await expect(auth.markGitHubAuthAccountInvalid(oauth.accountId, 'unauthorized')).resolves.toBe(true);
    await expect(auth.getGitHubAuthByAccountId(oauth.accountId)).resolves.toBeNull();
    await expect(auth.getGitHubAuthByAccountId(pat.accountId)).resolves.toMatchObject({ accessToken: 'pat' });
    expect(await auth.getGitHubAuthAccounts()).toEqual([
      expect.objectContaining({ id: oauth.accountId, status: 'invalid', providerUserStatus: 'available' }),
      expect.objectContaining({ id: pat.accountId, status: 'valid', providerUserStatus: 'available' }),
    ]);
    await expect(auth.removeGitHubAuthAccount(oauth.accountId)).resolves.toBe(true);
    await expect(auth.removeGitHubAuthAccount(oauth.accountId)).resolves.toBe(false);
  });

  it('fails closed on malformed or unsupported storage and leaves it untouched', async () => {
    const filePath = path.join(directory, 'github-auth.json');
    await fs.writeFile(filePath, '{broken', 'utf8');
    await expect(auth.getGitHubAuthAccounts()).rejects.toMatchObject({ code: 'INVALID_GITHUB_AUTH' });
    await expect(auth.setGitHubAuth({ accessToken: 'secret', user: { id: 7, login: 'user' } })).rejects.toMatchObject({ code: 'INVALID_GITHUB_AUTH' });
    expect(await fs.readFile(filePath, 'utf8')).toBe('{broken');

    await fs.writeFile(filePath, JSON.stringify({ version: 3, activeCredentialId: null, credentials: [] }), 'utf8');
    await expect(auth.getGitHubAuthAccounts()).rejects.toMatchObject({ code: 'INVALID_GITHUB_AUTH' });
  });

  it('serializes complete transactions across independent store instances without losing credentials', async () => {
    const filePath = path.join(directory, 'shared-github-auth.json');
    const firstStore = auth.createGitHubAuthStore({ filePath });
    const secondStore = auth.createGitHubAuthStore({ filePath });
    await Promise.all([
      firstStore.setAccount({ accessToken: 'one', user: { id: 1, login: 'one' }, source: 'oauth' }),
      secondStore.setAccount({ accessToken: 'two', user: { id: 2, login: 'two' }, source: 'pat' }),
    ]);

    await expect(firstStore.listAccounts()).resolves.toHaveLength(2);
    expect((await fs.readdir(directory)).filter((name) => name.endsWith('.lock') || name.endsWith('.tmp'))).toEqual([]);
  });

  it('does not lose concurrent credentials written by separate processes', async () => {
    const filePath = path.join(directory, 'multi-process-github-auth.json');
    const worker = ({ token, id, login, source }) => `
      import(${JSON.stringify(authModuleUrl)}).then(async ({ createGitHubAuthStore }) => {
        const store = createGitHubAuthStore({ filePath: ${JSON.stringify(filePath)} });
        await store.setAccount({ accessToken: ${JSON.stringify(token)}, user: { id: ${id}, login: ${JSON.stringify(login)} }, source: ${JSON.stringify(source)} });
      }).catch((error) => { console.error(error); process.exitCode = 1; });
    `;

    await Promise.all([
      execFileAsync(process.execPath, ['-e', worker({ token: 'one', id: 1, login: 'one', source: 'oauth' })]),
      execFileAsync(process.execPath, ['-e', worker({ token: 'two', id: 2, login: 'two', source: 'pat' })]),
    ]);

    const store = auth.createGitHubAuthStore({ filePath });
    await expect(store.listAccounts()).resolves.toHaveLength(2);
    expect((await fs.readdir(directory)).filter((name) => name.endsWith('.lock') || name.endsWith('.tmp'))).toEqual([]);
  });

  it('constructs Octokit for the exact requested credential', async () => {
    const first = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 7, login: 'first' } });
    await auth.setGitHubAuth({ accessToken: 'token-two', user: { id: 8, login: 'current' } });
    const fetch = vi.fn(async () => Response.json({ id: 7, login: 'first' }));
    vi.stubGlobal('fetch', fetch);

    const context = await octokit.getOctokitForAccountId(first.accountId);
    await context.octokit.rest.users.getAuthenticated();

    expect(context).toMatchObject({
      accountId: first.accountId,
      credentialRevision: first.credentialRevision,
      providerUserId: first.providerUserId,
    });
    expect(fetch.mock.calls[0][1].headers.authorization).toBe('token token-one');
    expect(await octokit.getOctokitForAccountId('github.com#999')).toBeNull();
  });
});

describe('gh-CLI settings writes', () => {
  const settingsPath = () => path.join(directory, 'settings.json');

  it('refuses to write on a malformed settings.json and leaves it untouched', async () => {
    const torn = '{"theme":"dark","ghCliActive":true,"nested":{"a":1';
    await fs.writeFile(settingsPath(), torn);
    expect(() => auth.setGhCliDisabled(true)).toThrowError(expect.objectContaining({ code: 'MALFORMED_SETTINGS' }));
    expect(() => auth.setGhCliActive(true)).toThrowError(expect.objectContaining({ code: 'MALFORMED_SETTINGS' }));
    await expect(fs.readFile(settingsPath(), 'utf8')).resolves.toBe(torn);
  });

  it('treats a non-object settings.json as malformed for writes', async () => {
    for (const contents of ['42', '[]']) {
      await fs.writeFile(settingsPath(), contents);
      expect(() => auth.setGhCliDisabled(true)).toThrowError(expect.objectContaining({ code: 'MALFORMED_SETTINGS' }));
      await expect(fs.readFile(settingsPath(), 'utf8')).resolves.toBe(contents);
    }
  });

  it('writes the gh-CLI keys when settings.json is missing', async () => {
    auth.setGhCliDisabled(true);
    const stored = JSON.parse(await fs.readFile(settingsPath(), 'utf8'));
    expect(stored).toEqual({ ghCliDisabled: true, ghCliActive: false });
    expect(auth.isGhCliDisabled()).toBe(true);
  });

  it('round-trips a valid settings.json, preserving every unrelated key', async () => {
    const original = { theme: 'dark', ghCliActive: true, openCodeGoPlan: 'pro', nested: { a: 1 }, profileName: 'work' };
    await fs.writeFile(settingsPath(), JSON.stringify(original));
    auth.setGhCliDisabled(true);
    const stored = JSON.parse(await fs.readFile(settingsPath(), 'utf8'));
    expect(stored).toEqual({ ...original, ghCliDisabled: true, ghCliActive: false });
  });

  it('keeps read-only gh-CLI getters lenient on a malformed settings.json', async () => {
    await fs.writeFile(settingsPath(), '{"theme":');
    expect(auth.isGhCliDisabled()).toBe(false);
    expect(auth.isGhCliActive()).toBe(false);
  });
});

describe('bounded reads (#1651)', () => {
  const ONE_MIB = 1024 * 1024;
  const EIGHT_MIB = 8 * 1024 * 1024;

  it('store read over the 1 MiB cap fails as a read failure, not an empty state', async () => {
    const filePath = path.join(directory, 'github-auth.json');
    await fs.writeFile(filePath, 'x'.repeat(ONE_MIB + 1));
    const store = auth.createGitHubAuthStore({ filePath });
    await expect(store.listAccounts()).rejects.toMatchObject({ code: 'BOUNDED_FILE_TOO_LARGE' });
  });

  it('store read of a FIFO is refused promptly, not blocked on', async () => {
    const filePath = path.join(directory, 'github-auth.json');
    await execFileAsync('mkfifo', [filePath]);
    const store = auth.createGitHubAuthStore({ filePath });
    await expect(store.listAccounts()).rejects.toMatchObject({ code: 'BOUNDED_FILE_NOT_REGULAR' });
  });

  it('lenient settings read over the 8 MiB cap answers {} (defaults)', async () => {
    const padded = JSON.stringify({ githubClientId: 'Ov23customclientid', pad: 'x'.repeat(EIGHT_MIB) });
    await fs.writeFile(path.join(directory, 'settings.json'), padded);
    expect(auth.getGitHubClientId()).toBe('Ov23lizomPOC3eFYo56r');
  });

  it('strict settings read over the 8 MiB cap throws and leaves the file untouched', async () => {
    const filePath = path.join(directory, 'settings.json');
    const padded = JSON.stringify({ githubClientId: 'Ov23customclientid', pad: 'x'.repeat(EIGHT_MIB) });
    await fs.writeFile(filePath, padded);
    expect(() => auth.setGhCliDisabled(true)).toThrow(expect.objectContaining({ code: 'BOUNDED_FILE_TOO_LARGE' }));
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(padded);
  });

  it('settings FIFO: lenient read answers defaults and strict read throws, both promptly', async () => {
    await execFileAsync('mkfifo', [path.join(directory, 'settings.json')]);
    expect(auth.getGitHubClientId()).toBe('Ov23lizomPOC3eFYo56r');
    expect(() => auth.setGhCliDisabled(true)).toThrow(expect.objectContaining({ code: 'BOUNDED_FILE_NOT_REGULAR' }));
  });

  it('within-cap store and settings reads behave as before', async () => {
    await auth.setGitHubAuth({ accessToken: 'ghp_ok', user: { id: 7, login: 'octo' }, source: 'pat' });
    const [account] = await auth.getGitHubAuthAccounts();
    expect(account).toMatchObject({ user: { login: 'octo' } });
    await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify({ githubClientId: 'Ov23customclientid' }));
    expect(auth.getGitHubClientId()).toBe('Ov23customclientid');
  });
});
