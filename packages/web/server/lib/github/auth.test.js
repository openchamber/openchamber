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
