import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBindingStore } from './binding-storage.js';
import { createBindingService } from './binding-service.js';
import { parseBindingResponse } from './binding-contract.js';

/**
 * Provider ids are open in every persisted store: a record a provider this
 * build does not know wrote (here `sourcehut`) parses, stays byte for byte, and
 * never takes a sibling provider down with it. Availability is decided when
 * it is read, not when the file is parsed.
 */
const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const endpoint = (url, fingerprint) => ({ displayUrl: url, fingerprint });
const githubRemote = {
  name: 'origin',
  fetch: { rawUrl: 'https://github.com/team/repo.git', ...endpoint('https://github.com/team/repo.git', 'origin-fetch') },
  push: { rawUrl: 'https://github.com/team/repo.git', ...endpoint('https://github.com/team/repo.git', 'origin-push') },
};
const forgeRemote = {
  name: 'forge',
  fetch: { rawUrl: 'https://forge.example.com/team/repo.git', ...endpoint('https://forge.example.com/team/repo.git', 'forge-fetch') },
  push: { rawUrl: 'https://forge.example.com/team/repo.git', ...endpoint('https://forge.example.com/team/repo.git', 'forge-push') },
};
const repository = {
  supported: true, repositoryId: 'repo_one', configRevision: 'config_one', bare: false,
  remotes: [githubRemote, forgeRemote], transportRevision: 'transport_one',
};
const storedBinding = {
  repositoryId: 'repo_one',
  revision: 2,
  state: 'bound',
  configRevision: 'config_one',
  providers: [
    {
      provider: 'sourcehut', instance: 'https://forge.example.com', accountId: 'occred:v1:sourcehut:one:r1',
      primaryRemote: 'forge', readiness: 'ready', endpoint: endpoint('https://forge.example.com/team/repo.git', 'forge-fetch'),
      repository: { owner: 'team', name: 'repo' },
    },
    {
      provider: 'github', instance: 'github.com', accountId: 'occred:v1:github:one:r1',
      primaryRemote: 'origin', readiness: 'ready', endpoint: endpoint('https://github.com/team/repo.git', 'origin-fetch'),
      repository: { owner: 'team', name: 'repo' },
    },
  ],
  remotes: [],
  auxiliary: [],
};
const storeFile = { version: 2, repositories: { repo_one: { revision: 2, binding: storedBinding } } };

const setup = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-open-ids-'));
  directories.push(directory);
  const filePath = path.join(directory, 'source-control-bindings.json');
  const encoded = `${JSON.stringify(storeFile, null, 2)}\n`;
  await fs.writeFile(filePath, encoded, 'utf8');
  const store = createBindingStore({ filePath });
  const service = createBindingService({
    store,
    resolveRepository: async () => repository,
    resolveTransportRepository: async () => repository,
  });
  return { filePath, encoded, store, service };
};
const readContext = (overrides = {}) => ({
  directory: '/repo', repositoryId: 'repo_one', provider: 'github', instance: 'github.com',
  accountId: 'occred:v1:github:one:r1', bindingRevision: 2, primaryRemote: 'origin', ...overrides,
});

describe('open provider ids in repository bindings', () => {
  it('parses a binding of an unknown provider and keeps the file untouched', async () => {
    const { filePath, encoded, store } = await setup();
    await expect(store.read('repo_one')).resolves.toMatchObject({ revision: 2, binding: { providers: [{ provider: 'sourcehut' }, { provider: 'github' }] } });
    // Reconciling another provider's account rewrites nothing of this one.
    await store.reconcileAccount({ provider: 'gitlab', instance: 'https://gitlab.com', accountId: 'nobody' });
    expect(await fs.readFile(filePath, 'utf8')).toBe(encoded);
  });

  it('serves the sibling provider and refuses the unknown one as unavailable', async () => {
    const { service } = await setup();
    await expect(service.validateReadContext(readContext())).resolves.toMatchObject({ provider: 'github', primaryRemote: 'origin' });
    await expect(service.validateReadContext(readContext({
      provider: 'sourcehut', instance: 'https://forge.example.com', accountId: 'occred:v1:sourcehut:one:r1', primaryRemote: 'forge',
    }))).rejects.toMatchObject({ code: 'SOURCE_CONTROL_PROVIDER_UNAVAILABLE', status: 422 });
    await expect(service.validateReadContext(readContext({ provider: 'Not An Id' })))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_READ_CONTEXT' });
  });

  it('presents the binding with the unknown provider in it', async () => {
    const { service } = await setup();
    const read = await service.get('/repo');
    expect(() => parseBindingResponse(read.binding)).not.toThrow();
    expect(read.binding.providers.map((entry) => entry.provider)).toEqual(['sourcehut', 'github']);
  });

  it('lets the user remove an association of a provider this build does not know, leaving the sibling', async () => {
    const { service, store } = await setup();
    await service.mutateProvider({
      directory: '/repo', expectedRepositoryId: 'repo_one', expectedRevision: 2, operation: 'remove',
      target: { provider: 'sourcehut', instance: 'https://forge.example.com', accountId: 'occred:v1:sourcehut:one:r1', primaryRemote: 'forge' },
    });
    const after = await store.read('repo_one');
    expect(after.binding.providers.map((entry) => entry.provider)).toEqual(['github']);
  });

  it('adopts and reconciles nothing for an unknown provider, without failing', async () => {
    const { service, filePath, encoded } = await setup();
    await expect(service.accountUnavailable({ provider: 'sourcehut', instance: 'https://forge.example.com', accountId: 'occred:v1:sourcehut:one:r1' }))
      .resolves.toEqual([]);
    await expect(service.accountConnected({
      provider: 'sourcehut', instance: 'https://forge.example.com', accountId: 'two', credentialRevision: 1, providerUserId: 'https://forge.example.com#3',
    })).resolves.toEqual([]);
    expect(await fs.readFile(filePath, 'utf8')).toBe(encoded);
  });
});
