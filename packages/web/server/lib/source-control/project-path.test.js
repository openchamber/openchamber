import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBindingService } from './binding-service.js';
import { createBindingStore } from './binding-storage.js';
import { parseBindingStore } from './binding-contract.js';
import { createMutationStore } from './mutation-storage.js';
import { allowsTopLevelProjects, joinProjectPath, splitProjectPath } from './project-path.js';
import { sourceControlProviderDescriptors } from './provider-descriptors.js';
import { fingerprintRemoteUrl, redactRemoteUrl } from './url-redaction.js';
import { parseTrackedItem, trackedItemKey } from '../tracked-items/items.js';

/**
 * A path provider (Gerrit) hosts projects with no owner segment (`demo`) as
 * well as nested ones (`team/app/sub`). Selectors keep `{ owner, name }`,
 * split on the last slash, with an empty owner for a top-level project;
 * every other provider keeps requiring an owner, and every key it stored
 * reads exactly as before.
 */
const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('project paths', () => {
  it('splits on the last slash and joins back', () => {
    expect(splitProjectPath('team/app/sub')).toEqual({ owner: 'team/app', name: 'sub' });
    expect(splitProjectPath('demo')).toEqual({ owner: '', name: 'demo' });
    expect(joinProjectPath('team/app', 'sub')).toBe('team/app/sub');
    expect(joinProjectPath('', 'demo')).toBe('demo');
    expect(allowsTopLevelProjects(sourceControlProviderDescriptors.get('gerrit'))).toBe(true);
    for (const id of ['github', 'gitlab', 'gitea']) expect(allowsTopLevelProjects(sourceControlProviderDescriptors.get(id))).toBe(false);
  });
});

describe('top-level projects in bindings', () => {
  const ORIGIN = 'https://gerrit.example.com';
  const endpoint = (url) => ({ rawUrl: url, displayUrl: redactRemoteUrl(url), fingerprint: fingerprintRemoteUrl(url) });
  const bindClone = async (url, provider = 'gerrit', instance = ORIGIN) => {
    const remote = { name: 'origin', fetch: endpoint(url), push: endpoint(url) };
    const context = { supported: true, repositoryId: 'repo_one', configRevision: 'config_one', bare: false, remotes: [remote], transportRevision: 'transport_one' };
    const files = new Map();
    const fsImpl = {
      readFile: async (file) => { if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(file); },
      mkdir: async () => {}, chmod: async () => {}, rm: async (file) => { files.delete(file); },
      writeFile: async (file, text) => { files.set(file, text); },
      rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
      open: async (file) => {
        if (files.has(file)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        files.set(file, '');
        return { writeFile: async (text) => { files.set(file, text); }, stat: async () => ({ dev: 1n, ino: 1n }), close: async () => {} };
      },
      lstat: async () => ({ dev: 1n, ino: 1n }), unlink: async (file) => { files.delete(file); },
    };
    const service = createBindingService({
      store: createBindingStore({ filePath: '/bindings.json', fsImpl }),
      resolveRepository: async () => ({ ...context, remotes: [{ name: 'origin', fetch: { displayUrl: remote.fetch.displayUrl, fingerprint: remote.fetch.fingerprint }, push: { displayUrl: remote.push.displayUrl, fingerprint: remote.push.fingerprint } }] }),
      resolveTransportRepository: vi.fn(async () => structuredClone(context)),
    });
    const result = await service.bindClonedRepository({
      directory: '/repo', approvedEndpoint: url, transportMode: 'anonymous',
      providerAccount: { provider, instance, accountId: 'acct-1' },
    });
    return { result, persisted: files.get('/bindings.json') };
  };

  it('binds a nested Gerrit project with its owner path', async () => {
    const { result } = await bindClone(`${ORIGIN}/team/app/sub`);
    expect(result.binding.providers[0].repository).toEqual({ owner: 'team/app', name: 'sub' });
  });

  it('binds a top-level Gerrit project and keeps the persisted record readable by older builds', async () => {
    const { result, persisted } = await bindClone(`${ORIGIN}/demo`);
    expect(result.binding.providers[0]).toMatchObject({ provider: 'gerrit', readiness: 'ready' });
    // No `repository` with an empty owner is written: the strict parser of a
    // build that predates top-level projects reads the file as it always did.
    expect(result.binding.providers[0]).not.toHaveProperty('repository');
    expect(() => parseBindingStore(JSON.parse(persisted))).not.toThrow();
    expect(persisted).not.toContain('"owner":""');
  });

  it('still refuses a single-segment path for an owner/name provider', async () => {
    await expect(bindClone('https://gitea.example.com/demo', 'gitea', 'https://gitea.example.com'))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDING' });
  });
});

describe('top-level projects in mutation records', () => {
  const makeStore = async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-project-path-'));
    directories.push(directory);
    return createMutationStore({ filePath: path.join(directory, 'source-control-mutations.json') });
  };
  const claim = (provider, owner) => ({
    key: `${provider}-${owner || 'top'}`, inputDigest: 'digest', kind: 'change-request-merge',
    actor: { provider, instance: 'https://forge.example.com', accountId: 'acct-1' },
    target: { repositoryId: 'repo', bindingRevision: 1, primaryRemote: 'origin', project: { id: 'demo', owner, name: 'demo' }, number: 4 },
  });

  it('accepts an empty owner only for a path provider, and round-trips it', async () => {
    const store = await makeStore();
    await expect(store.claim(claim('gerrit', ''))).resolves.toMatchObject({ status: 'claimed' });
    await expect(store.complete('gerrit-top', 'digest', { state: 'succeeded', result: { project: { id: 'demo', owner: '', name: 'demo' } } }))
      .resolves.toMatchObject({ state: 'succeeded' });
    await expect(store.read('gerrit-top')).resolves.toMatchObject({ target: { project: { owner: '' } } });
    await expect(store.claim(claim('gitea', ''))).rejects.toThrow();
  });
});

describe('top-level projects in tracked items', () => {
  const item = (provider, owner) => ({ provider, instance: 'https://forge.example.com', kind: 'pull', owner, repo: 'demo', number: 7 });

  it('accepts an empty owner only for a path provider and keys it by the joined path', () => {
    const gerrit = parseTrackedItem(item('gerrit', ''));
    expect(gerrit).toMatchObject({ owner: '', repo: 'demo' });
    expect(trackedItemKey(gerrit)).toBe('gerrit|https://forge.example.com|pull|demo#7');
    expect(parseTrackedItem(item('gitea', ''))).toBeNull();
    // Owners that exist keep the key they always had.
    expect(trackedItemKey(parseTrackedItem(item('gitea', 'team')))).toBe('gitea|https://forge.example.com|pull|team/demo#7');
    expect(trackedItemKey(parseTrackedItem(item('gerrit', 'team/app')))).toBe('gerrit|https://forge.example.com|pull|team/app/demo#7');
  });
});
