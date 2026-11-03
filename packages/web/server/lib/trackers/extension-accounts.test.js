import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TRACKER_SESSION_RECORDS_MAX, createTrackerAccounts, trackerAccountsPersistPath } from './extension-accounts.js';

const dirs = [];
const store = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-tracker-accounts-'));
  dirs.push(dir);
  let clock = 1_000;
  const accounts = createTrackerAccounts({ persistPath: trackerAccountsPersistPath(dir), now: () => (clock += 1) });
  return { accounts, dir };
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const mona = { id: 'u-1', login: 'mona', name: 'Mona' };
const token = (value) => ({ kind: 'token', token: value, login: null });
const target = { authorizeUrl: 'https://yt.example.com/hub/auth', tokenUrl: 'https://yt.example.com/hub/token' };

describe('tracker accounts', () => {
  it('stores accounts on one instance with their credentials, hands credentials to the reader alone, and keeps the file private', async () => {
    const { accounts, dir } = await store();
    const connection = accounts.beginConnect('ext-yt');
    const view = await accounts.connect('ext-yt', { instance: 'https://yt.example.com', account: mona, credential: token('secret-1') }, connection);
    expect(view).toEqual({
      instance: 'https://yt.example.com',
      accounts: [{ id: 'u-1', login: 'mona', name: 'Mona', connectedAt: 1_001, status: 'valid', method: 'token' }],
      activeAccountId: 'u-1',
      hasClient: false,
    });
    expect(JSON.stringify(view)).not.toContain('secret-1');
    const stored = await accounts.read('ext-yt');
    expect(stored.accounts[0].credential).toEqual(token('secret-1'));
    expect(stored.accounts[0].revision).toMatch(/^[0-9a-f-]{36}$/);
    const mode = (await fs.stat(trackerAccountsPersistPath(dir))).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(await accounts.list()).toEqual({ 'ext-yt': view });
  });

  it('a second account joins the instance and becomes current; the same account connecting again is replaced', async () => {
    const { accounts } = await store();
    await accounts.connect('ext-yt', { instance: 'https://yt.example.com', account: mona, credential: token('a') });
    await accounts.connect('ext-yt', { instance: 'https://yt.example.com', account: { id: 'u-2', login: 'bob' }, credential: token('b') });
    let view = await accounts.publicView('ext-yt');
    expect(view.accounts.map((account) => account.id)).toEqual(['u-1', 'u-2']);
    expect(view.activeAccountId).toBe('u-2');
    expect(await accounts.activate('ext-yt', 'u-1')).toBe(true);
    expect(await accounts.activate('ext-yt', 'nope')).toBe(false);
    expect((await accounts.publicView('ext-yt')).activeAccountId).toBe('u-1');

    await accounts.connect('ext-yt', { instance: 'https://yt.example.com', account: { ...mona, name: 'Mona L.' }, credential: token('a2') });
    view = await accounts.publicView('ext-yt');
    expect(view.accounts.map((account) => `${account.id}:${account.name ?? ''}`)).toEqual(['u-2:', 'u-1:Mona L.']);
    expect((await accounts.read('ext-yt')).accounts.find((account) => account.id === 'u-1').credential.token).toBe('a2');
  });

  it('refuses a connect to another server while accounts live on this one', async () => {
    const { accounts } = await store();
    await accounts.connect('ext-yt', { instance: 'https://yt.example.com', account: mona, credential: token('a') });
    await expect(accounts.connect('ext-yt', { instance: 'https://other.example.com', account: { id: 'u-9', login: null }, credential: token('z') }))
      .rejects.toMatchObject({ status: 409, code: 'INSTANCE_MISMATCH' });
    await expect(accounts.setClient('ext-yt', { instance: 'https://other.example.com', clientId: 'c', clientSecret: 's', target })).rejects.toMatchObject({ code: 'INSTANCE_MISMATCH' });
  });

  it('a disconnect wins over a connect whose verification is still pending', async () => {
    const { accounts } = await store();
    const connection = accounts.beginConnect('ext-yt');
    // Nothing is connected yet; the disconnect still invalidates the pending connect.
    expect(await accounts.removeAccount('ext-yt', 'u-1')).toBe(false);
    expect(await accounts.connect('ext-yt', { instance: 'https://yt.example.com', account: mona, credential: token('a') }, connection)).toBeNull();
    expect(await accounts.publicView('ext-yt')).toEqual({ instance: null, accounts: [], activeAccountId: null, hasClient: false });
    // A later connect's identity supersedes an earlier one too.
    const first = accounts.beginConnect('ext-yt');
    const second = accounts.beginConnect('ext-yt');
    expect(await accounts.connect('ext-yt', { instance: 'https://yt.example.com', account: mona, credential: token('a') }, first)).toBeNull();
    expect(await accounts.connect('ext-yt', { instance: 'https://yt.example.com', account: mona, credential: token('b') }, second)).not.toBeNull();
  });

  it('writes an account off only at the revision it was read at, even when the replacement has the same content', async () => {
    const { accounts } = await store();
    await accounts.connect('ext-yt', { instance: 'https://yt.example.com', account: mona, credential: token('a') });
    const before = (await accounts.read('ext-yt')).accounts[0];
    await accounts.connect('ext-yt', { instance: 'https://yt.example.com', account: mona, credential: token('a') });
    expect(await accounts.markInvalid('ext-yt', 'u-1', 'unauthorized', before.revision)).toBe(false);
    expect((await accounts.publicView('ext-yt')).accounts[0].status).toBe('valid');
    const current = (await accounts.read('ext-yt')).accounts[0];
    expect(await accounts.markInvalid('ext-yt', 'u-1', 'unauthorized', current.revision)).toBe(true);
    expect((await accounts.publicView('ext-yt')).accounts[0]).toMatchObject({ status: 'invalid', invalidReason: 'unauthorized' });
    // An invalid account cannot be made current.
    expect(await accounts.activate('ext-yt', 'u-1')).toBe(false);
  });

  it('refreshes an OAuth credential against its revision and keeps the client only for the same id and endpoints', async () => {
    const { accounts } = await store();
    const minted = { kind: 'oauth', accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 5_000, target };
    await accounts.connect('ext-yt', { instance: 'https://yt.example.com', account: mona, credential: minted });
    const revision = (await accounts.read('ext-yt')).accounts[0].revision;
    const refreshed = { ...minted, accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: 9_000 };
    expect(await accounts.updateCredential('ext-yt', 'u-1', refreshed, 'stale-revision')).toBeNull();
    const next = await accounts.updateCredential('ext-yt', 'u-1', refreshed, revision);
    expect(next).not.toBe(revision);
    expect((await accounts.read('ext-yt')).accounts[0]).toMatchObject({ revision: next, credential: refreshed, status: 'valid' });

    await accounts.setClient('ext-yt', { instance: 'https://yt.example.com', clientId: 'client-1', clientSecret: 'shh', target });
    expect(await accounts.readClient('ext-yt', target)).toEqual({ id: 'client-1', secret: 'shh' });
    await accounts.setClient('ext-yt', { instance: 'https://yt.example.com', clientId: 'client-1', clientSecret: '', target });
    expect(await accounts.readClient('ext-yt', target)).toEqual({ id: 'client-1', secret: 'shh' });
    await accounts.setClient('ext-yt', { instance: 'https://yt.example.com', clientId: 'client-2', clientSecret: '', target });
    expect(await accounts.readClient('ext-yt', target)).toEqual({ id: 'client-2', secret: '' });
    expect(await accounts.readClient('ext-yt', { ...target, tokenUrl: 'https://yt.example.com/moved' })).toBeNull();
    expect((await accounts.publicView('ext-yt')).hasClient).toBe(true);
  });

  it('the last account leaving forgets the server, the client and the mapping; preferences and session records stay', async () => {
    const { accounts } = await store();
    await accounts.connect('ext-yt', { instance: 'https://yt.example.com', account: mona, credential: token('a') });
    await accounts.setClient('ext-yt', { instance: 'https://yt.example.com', clientId: 'c', clientSecret: 's', target });
    await accounts.setMapping('ext-yt', { defaultProjectPath: '/repo', containerProjectPaths: { 'p-1': '/repo' } });
    await accounts.setPreferences('ext-yt', { sessionComments: true });
    await accounts.writeSessionRecord('ext-yt', 'ses_1', { identifier: 'PROJ-1', sessionOrigin: 'https://app.example.com', started: true, completed: false, failure: false });
    expect(await accounts.mapping('ext-yt')).toEqual({ defaultProjectPath: '/repo', containerProjectPaths: { 'p-1': '/repo' } });
    expect(await accounts.removeAccount('ext-yt', 'u-1')).toBe(true);
    expect(await accounts.publicView('ext-yt')).toEqual({ instance: null, accounts: [], activeAccountId: null, hasClient: false });
    expect(await accounts.mapping('ext-yt')).toEqual({ defaultProjectPath: null, containerProjectPaths: {} });
    expect(await accounts.preferences('ext-yt')).toEqual({ sessionComments: true });
    expect(await accounts.sessionRecord('ext-yt', 'ses_1')).toMatchObject({ identifier: 'PROJ-1', started: true });
    // Removal of the extension forgets everything.
    expect(await accounts.remove('ext-yt')).toBe(true);
    expect(await accounts.remove('ext-yt')).toBe(false);
    expect(await accounts.sessionRecord('ext-yt', 'ses_1')).toBeNull();
  });

  it('keeps the newest session records', async () => {
    const { accounts } = await store();
    await accounts.connect('ext-yt', { instance: 'https://yt.example.com', account: mona, credential: token('a') });
    for (let index = 0; index < TRACKER_SESSION_RECORDS_MAX + 5; index += 1) {
      await accounts.writeSessionRecord('ext-yt', `ses_${index}`, { identifier: `P-${index}`, sessionOrigin: null, started: true, completed: false, failure: false });
    }
    expect(await accounts.sessionRecord('ext-yt', 'ses_0')).toBeNull();
    expect(await accounts.sessionRecord('ext-yt', `ses_${TRACKER_SESSION_RECORDS_MAX + 4}`)).not.toBeNull();
    expect(Object.keys((await accounts.read('ext-yt')).sessions)).toHaveLength(TRACKER_SESSION_RECORDS_MAX);
  });

  it('session records merge their kind flags; records, mapping and preferences are never written for a tracker that is gone', async () => {
    const { accounts } = await store();
    const record = (flags) => ({ identifier: 'PROJ-1', sessionOrigin: null, started: true, completed: false, failure: false, ...flags });
    expect(await accounts.writeSessionRecord('ext-yt', 'ses_1', record({}))).toBe(false);
    expect(await accounts.setMapping('ext-yt', { defaultProjectPath: '/repo', containerProjectPaths: {} })).toBeNull();
    expect(await accounts.setPreferences('ext-yt', { sessionComments: true })).toEqual({ sessionComments: false });
    expect(await accounts.read('ext-yt')).toBeNull();
    await accounts.connect('ext-yt', { instance: 'https://yt.example.com', account: mona, credential: token('a') });
    // Two posts that each read the record before the other wrote keep both flags.
    await accounts.writeSessionRecord('ext-yt', 'ses_1', record({ completed: true }));
    await accounts.writeSessionRecord('ext-yt', 'ses_1', record({ failure: true }));
    expect(await accounts.sessionRecord('ext-yt', 'ses_1')).toEqual(record({ completed: true, failure: true }));
    // A pending connect is cancelled only by the operation that holds it.
    const first = accounts.beginConnect('ext-yt');
    expect(accounts.cancelConnect('ext-yt', Symbol('other'))).toBe(false);
    expect(accounts.cancelConnect('ext-yt', first)).toBe(true);
    expect(accounts.cancelConnect('ext-yt', first)).toBe(false);
  });

  it('a corrupt file is an error, never a disconnected tracker; writes to one file land in order', async () => {
    const { accounts, dir } = await store();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(trackerAccountsPersistPath(dir), '{"version":1,"trackers":{"ext-yt":"nope"}}');
    await expect(accounts.publicView('ext-yt')).rejects.toMatchObject({ code: 'INVALID_TRACKER_ACCOUNTS_STORE' });
    await fs.writeFile(trackerAccountsPersistPath(dir), '');
    await accounts.connect('ext-a', { instance: 'https://a.example.com', account: mona, credential: token('a') });
    await accounts.connect('ext-b', { instance: 'https://b.example.com', account: mona, credential: token('b') });
    await Promise.all([
      accounts.setPreferences('ext-a', { sessionComments: true }),
      accounts.setPreferences('ext-b', { sessionComments: false }),
      accounts.setMapping('ext-a', { defaultProjectPath: null, containerProjectPaths: {} }),
    ]);
    expect(await accounts.preferences('ext-a')).toEqual({ sessionComments: true });
    expect(await accounts.preferences('ext-b')).toEqual({ sessionComments: false });
  });
});
