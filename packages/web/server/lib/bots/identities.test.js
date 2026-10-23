import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createBotIdentityStore } from './identities.js';
import { accountCredential } from './services/http.test-support.js';

const directories = [];
const create = async (options = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-identities-test-'));
  directories.push(dataDir);
  return { dataDir, store: createBotIdentityStore({ dataDir, ...options }) };
};
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

it('stores secrets atomically at 0600 and returns only redacted identities across reload and rotation', async () => {
  const { store, dataDir } = await create();
  const identity = await store.create({ kind: 'jira-service', label: 'Jira service', site: 'https://acme.atlassian.net',
    email: 'bot@acme.test', apiToken: 'original-secret' });
  expect(identity).toMatchObject({ revision: 1, kind: 'jira-service', site: 'https://acme.atlassian.net' });
  expect(JSON.stringify(await store.list())).not.toContain('original-secret');
  expect((await fs.stat(path.join(dataDir, 'bot-identities.json'))).mode & 0o777).toBe(0o600);
  const rotated = await store.update(identity.id, 1, { kind: 'jira-service', label: 'Jira service',
    site: 'https://acme.atlassian.net', email: 'bot@acme.test', apiToken: 'new-secret' });
  expect(rotated.revision).toBe(2);
  await expect(store.resolve(identity.id, 1)).rejects.toMatchObject({ code: 'BOT_IDENTITY_UNAVAILABLE', state: 'needs-you' });
  const reloaded = createBotIdentityStore({ dataDir });
  expect((await reloaded.resolve(identity.id, 2)).definition.apiToken).toBe('new-secret');
  expect(JSON.stringify(await reloaded.list())).not.toMatch(/apiToken|new-secret/);
  await reloaded.remove(identity.id, 2);
  expect(await reloaded.list()).toEqual([]);
});

it('resolves only the explicitly selected persisted GitHub credential and revision', async () => {
  const calls = [];
  const { store } = await create({ readGitHubAccount: async (id, revision) => {
    calls.push([id, revision]);
    return id === 'chosen' && revision === 1 ? accountCredential('chosen') : null;
  } });
  await store.create({ kind: 'github-account', label: 'Chosen', accountId: 'chosen', credentialRevision: 1 });
  await expect(store.create({ kind: 'github-account', label: 'Missing', accountId: 'missing', credentialRevision: 1 }))
    .rejects.toMatchObject({ code: 'BOT_IDENTITY_UNAVAILABLE' });
  expect(calls).toEqual([['chosen', 1], ['missing', 1]]);
});

it('keeps OAuth client secrets private across reload, replacement and revision refusal', async () => {
  // Given a service-account OAuth credential supplied through identity management.
  const { store, dataDir } = await create();
  const definition = { kind: 'jira-oauth', label: 'PiggyOps', site: 'https://acme.atlassian.net',
    cloudId: 'd313a597-a578-4b2e-bf98-93308087542e', clientId: 'client-id', clientSecret: 'disposable-original' };
  // When it is stored and later replaced with a new secret.
  const identity = await store.create(definition);
  const replacement = await store.update(identity.id, 1, { ...definition, clientSecret: 'disposable-replacement' });
  const reloaded = createBotIdentityStore({ dataDir });
  // Then only public metadata is returned and the old revision grants no authority.
  expect(identity).toEqual({ id: identity.id, revision: 1, configured: true, kind: definition.kind,
    label: definition.label, site: definition.site, cloudId: definition.cloudId, clientId: definition.clientId });
  expect(replacement.revision).toBe(2);
  expect(JSON.stringify(await reloaded.list())).not.toMatch(/clientSecret|disposable-/);
  expect((await reloaded.resolve(identity.id, 2)).definition.clientSecret).toBe('disposable-replacement');
  await expect(reloaded.resolve(identity.id, 1)).rejects.toMatchObject({ code: 'BOT_IDENTITY_UNAVAILABLE' });
  expect((await fs.stat(path.join(dataDir, 'bot-identities.json'))).mode & 0o777).toBe(0o600);
});

it.each(['../other', 'cloud-id', 'd313a597-a578-4b2e-bf98-93308087542e/other'])('refuses an invalid OAuth cloud ID %s before storing it', async (cloudId) => {
  // Given a cloud ID that cannot identify a single Atlassian tenant.
  const { store } = await create();
  // When identity creation crosses the storage boundary.
  await expect(store.create({ kind: 'jira-oauth', label: 'Invalid', site: 'https://acme.atlassian.net',
    cloudId, clientId: 'client-id', clientSecret: 'disposable' })).rejects.toThrow();
  // Then no identity was stored.
  expect(await store.list()).toEqual([]);
});

it('keeps the GitHub App key private and rejects malformed keys and unsafe sites', async () => {
  const { store, dataDir } = await create();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const app = await store.create({ kind: 'github-app', label: 'App', appId: '7', installationId: '8', privateKey });
  expect(JSON.stringify(app)).not.toContain('PRIVATE KEY');
  expect((await fs.stat(path.join(dataDir, 'bot-identities.json'))).mode & 0o777).toBe(0o600);
  await expect(store.create({ kind: 'github-app', label: 'Bad', appId: '7', installationId: '8', privateKey: 'bad' }))
    .rejects.toMatchObject({ code: 'BOT_APP_KEY_INVALID' });
  for (const site of ['http://acme.atlassian.net', 'https://localhost', 'https://169.254.169.254',
    'https://acme.atlassian.net.evil.test', 'https://user:pass@acme.atlassian.net', 'https://acme.atlassian.net/path']) {
    await expect(store.create({ kind: 'jira-account', label: 'Bad', site, email: 'a@b.test', apiToken: 'secret' })).rejects.toThrow();
  }
});

it('fails closed on corrupt storage and preserves the old secret after failed rename', async () => {
  const { store, dataDir } = await create();
  const definition = { kind: 'discord-app', label: 'Discord', applicationId: '12345678', botToken: 'old-secret' };
  const identity = await store.create(definition);
  const broken = createBotIdentityStore({ dataDir, fsImpl: { ...fs, rename: async () => { throw new Error('disk failure'); } } });
  await expect(broken.update(identity.id, 1, { ...definition, botToken: 'new-secret' })).rejects.toMatchObject({ code: 'BOT_IDENTITIES_WRITE_FAILED' });
  expect((await store.resolve(identity.id, 1)).definition.botToken).toBe('old-secret');
  expect((await fs.readdir(dataDir)).some((name) => name.endsWith('.tmp'))).toBe(false);
  await fs.writeFile(path.join(dataDir, 'bot-identities.json'), '{bad');
  await expect(store.list()).rejects.toMatchObject({ code: 'BOT_IDENTITIES_INVALID' });
  await expect(store.create(definition)).rejects.toMatchObject({ code: 'BOT_IDENTITIES_INVALID' });
  expect(await fs.readFile(path.join(dataDir, 'bot-identities.json'), 'utf8')).toBe('{bad');
});
