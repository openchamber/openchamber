import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
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
});
