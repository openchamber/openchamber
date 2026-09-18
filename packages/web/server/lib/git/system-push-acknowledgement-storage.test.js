import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSystemPushAcknowledgementStore } from './system-push-acknowledgement-storage.js';
import { gitStorageProcess } from './storage-process.test-support.js';

const REPOSITORY_ONE = `repo_${'a'.repeat(43)}`;
const REPOSITORY_TWO = `repo_${'b'.repeat(43)}`;
const ENDPOINT_ONE = 'c'.repeat(43);
const ENDPOINT_TWO = 'd'.repeat(43);
const TRANSPORT_ONE = 'e'.repeat(43);
const TRANSPORT_TWO = 'f'.repeat(43);
const AUTHORITY_ONE = [REPOSITORY_ONE, 'origin', ENDPOINT_ONE, TRANSPORT_ONE];
const AUTHORITY_TWO = [REPOSITORY_TWO, 'mirror', ENDPOINT_TWO, TRANSPORT_TWO];
const directories = [];
const children = [];
const makeStore = async (options = {}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-system-push-ack-'));
  directories.push(directory);
  const filePath = path.join(directory, 'acknowledgements.json');
  return { filePath, store: createSystemPushAcknowledgementStore({ filePath, ...options }) };
};

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.stop()));
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('system push acknowledgement storage', () => {
  it('preserves sibling v3 acknowledgements written by independent processes', async () => {
    const { filePath, store } = await makeStore();
    const pair = await Promise.all([
      gitStorageProcess('acknowledgement', filePath),
      gitStorageProcess('acknowledgement', filePath),
    ]);
    children.push(...pair);
    const results = await Promise.all([
      pair[0].call('acknowledge', AUTHORITY_ONE).result,
      pair[1].call('acknowledge', AUTHORITY_TWO).result,
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    await expect(store.isAcknowledged(...AUTHORITY_ONE)).resolves.toBe(true);
    await expect(store.isAcknowledged(...AUTHORITY_TWO)).resolves.toBe(true);
  });

  it('fails a contended read and retains a crashed owner lock for operator recovery', async () => {
    const { filePath } = await makeStore();
    const owner = await gitStorageProcess('acknowledgement', filePath);
    children.push(owner);
    owner.call('hold-lock');
    await expect.poll(() => owner.events.some((event) => event.event === 'locked')).toBe(true);
    const nonce = await fs.readFile(`${filePath}.lock`, 'utf8');
    await owner.stop();
    const store = createSystemPushAcknowledgementStore({ filePath, lockWaitMs: 20 });
    await expect(store.isAcknowledged(...AUTHORITY_ONE)).rejects.toMatchObject({
      code: 'SOURCE_CONTROL_LOCK_BUSY', status: 503,
    });
    expect(await fs.readFile(`${filePath}.lock`, 'utf8')).toBe(nonce);
  });

  it('persists exact v3 push authority atomically with mode 0600', async () => {
    const { filePath, store } = await makeStore();
    await expect(store.isAcknowledged(...AUTHORITY_ONE)).resolves.toBe(false);
    await store.acknowledge(...AUTHORITY_ONE);
    await expect(store.isAcknowledged(...AUTHORITY_ONE)).resolves.toBe(true);
    for (const changed of [
      [REPOSITORY_TWO, 'origin', ENDPOINT_ONE, TRANSPORT_ONE],
      [REPOSITORY_ONE, 'mirror', ENDPOINT_ONE, TRANSPORT_ONE],
      [REPOSITORY_ONE, 'origin', ENDPOINT_TWO, TRANSPORT_ONE],
      [REPOSITORY_ONE, 'origin', ENDPOINT_ONE, TRANSPORT_TWO],
    ]) await expect(store.isAcknowledged(...changed)).resolves.toBe(false);
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toEqual({
      version: 3,
      acknowledgements: [{
        repositoryId: REPOSITORY_ONE,
        remoteName: 'origin',
        endpointFingerprint: ENDPOINT_ONE,
        transportRevision: TRANSPORT_ONE,
      }],
    });
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(path.dirname(filePath))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    await expect(createSystemPushAcknowledgementStore({ filePath }).isAcknowledged(...AUTHORITY_ONE)).resolves.toBe(true);
  });

  it.each([
    ['https://private.example/repo', 'origin', ENDPOINT_ONE, TRANSPORT_ONE],
    [REPOSITORY_ONE, 'https://private.example/repo', ENDPOINT_ONE, TRANSPORT_ONE],
    [REPOSITORY_ONE, 'origin', 'https://private.example/repo', TRANSPORT_ONE],
    [REPOSITORY_ONE, 'origin', ENDPOINT_ONE, 'https://private.example/repo'],
    [REPOSITORY_ONE, '../origin', ENDPOINT_ONE, TRANSPORT_ONE],
    [REPOSITORY_ONE, 'git@example.com:owner/repo.git', ENDPOINT_ONE, TRANSPORT_ONE],
    [REPOSITORY_ONE, '/private/repo', ENDPOINT_ONE, TRANSPORT_ONE],
  ])('rejects unsafe acknowledgement authority %# before storage access', async (
    repositoryId, remoteName, endpointFingerprint, transportRevision,
  ) => {
    const { filePath, store } = await makeStore();
    const invalidAuthority = [repositoryId, remoteName, endpointFingerprint, transportRevision];
    await expect(store.isAcknowledged(...invalidAuthority)).rejects.toMatchObject({
      code: 'SYSTEM_PUSH_ACKNOWLEDGEMENT_STORE_INVALID',
    });
    await expect(store.acknowledge(...invalidAuthority)).rejects.toMatchObject({
      code: 'SYSTEM_PUSH_ACKNOWLEDGEMENT_STORE_INVALID',
    });
    await expect(fs.readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('bounds records by retaining only the newest exact authorities', async () => {
    const { store } = await makeStore({ maxAcknowledgements: 1 });
    await store.acknowledge(...AUTHORITY_ONE);
    await store.acknowledge(...AUTHORITY_TWO);
    await expect(store.isAcknowledged(...AUTHORITY_ONE)).resolves.toBe(false);
    await expect(store.isAcknowledged(...AUTHORITY_TWO)).resolves.toBe(true);
  });

  it.each([
    '{broken',
    JSON.stringify({ version: 4, acknowledgements: [] }),
    JSON.stringify({ version: 2, acknowledgements: [], extra: true }),
    JSON.stringify({ version: 2, acknowledgements: {} }),
    JSON.stringify({ version: 1, acknowledgements: [{ repositoryId: REPOSITORY_ONE, transportRevision: TRANSPORT_ONE }] }),
    JSON.stringify({ version: 1, acknowledgements: [{ repositoryId: REPOSITORY_ONE, configRevision: 'https://private.example/repo' }] }),
    JSON.stringify({ version: 2, acknowledgements: [{ repositoryId: 'https://private.example/repo', transportRevision: TRANSPORT_ONE }] }),
    JSON.stringify({ version: 3, acknowledgements: [{ repositoryId: REPOSITORY_ONE, remoteName: 'https://private.example/repo', endpointFingerprint: ENDPOINT_ONE, transportRevision: TRANSPORT_ONE }] }),
    JSON.stringify({ version: 3, acknowledgements: [{ repositoryId: REPOSITORY_ONE, remoteName: 'origin', endpointFingerprint: 'https://private.example/repo', transportRevision: TRANSPORT_ONE }] }),
    JSON.stringify({ version: 3, acknowledgements: [{ repositoryId: REPOSITORY_ONE, remoteName: 'origin', endpointFingerprint: ENDPOINT_ONE, transportRevision: 'short' }] }),
    JSON.stringify({ version: 3, acknowledgements: [{ repositoryId: REPOSITORY_ONE, remoteName: 'origin', endpointFingerprint: ENDPOINT_ONE, transportRevision: TRANSPORT_ONE, extra: true }] }),
    JSON.stringify({ version: 3, acknowledgements: Array(2).fill({ repositoryId: REPOSITORY_ONE, remoteName: 'origin', endpointFingerprint: ENDPOINT_ONE, transportRevision: TRANSPORT_ONE }) }),
  ])('rejects malformed, unsafe, or unknown format %# without replacing it', async (original) => {
    const { filePath, store } = await makeStore();
    await fs.writeFile(filePath, original, { mode: 0o600 });
    await expect(store.isAcknowledged(...AUTHORITY_ONE)).rejects.toMatchObject({
      code: 'SYSTEM_PUSH_ACKNOWLEDGEMENT_STORE_INVALID',
    });
    await expect(store.acknowledge(...AUTHORITY_ONE)).rejects.toMatchObject({
      code: 'SYSTEM_PUSH_ACKNOWLEDGEMENT_STORE_INVALID',
    });
    expect(await fs.readFile(filePath, 'utf8')).toBe(original);
    expect(await fs.readdir(path.dirname(filePath))).toEqual(['acknowledgements.json']);
  });

  it('rejects an unknown store version over capacity rather than discarding it', async () => {
    const { filePath, store } = await makeStore({ maxAcknowledgements: 1 });
    const original = JSON.stringify({ version: 2, acknowledgements: [
      { repositoryId: REPOSITORY_ONE, transportRevision: TRANSPORT_ONE },
      { repositoryId: REPOSITORY_TWO, transportRevision: TRANSPORT_TWO },
    ] });
    await fs.writeFile(filePath, original, { mode: 0o600 });
    await expect(store.isAcknowledged(...AUTHORITY_ONE)).rejects.toMatchObject({
      code: 'SYSTEM_PUSH_ACKNOWLEDGEMENT_STORE_INVALID',
    });
    await expect(store.acknowledge(...AUTHORITY_ONE)).rejects.toMatchObject({
      code: 'SYSTEM_PUSH_ACKNOWLEDGEMENT_STORE_INVALID',
    });
    expect(await fs.readFile(filePath, 'utf8')).toBe(original);
  });

  it('serializes explicit acknowledgements when replacing an empty store', async () => {
    const { filePath, store } = await makeStore();
    await fs.writeFile(filePath, JSON.stringify({ version: 3, acknowledgements: [] }), { mode: 0o600 });
    await Promise.all([
      store.acknowledge(...AUTHORITY_ONE),
      store.acknowledge(...AUTHORITY_TWO),
      store.acknowledge(...AUTHORITY_ONE),
    ]);
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toEqual({ version: 3, acknowledgements: [
      { repositoryId: REPOSITORY_ONE, remoteName: 'origin', endpointFingerprint: ENDPOINT_ONE, transportRevision: TRANSPORT_ONE },
      { repositoryId: REPOSITORY_TWO, remoteName: 'mirror', endpointFingerprint: ENDPOINT_TWO, transportRevision: TRANSPORT_TWO },
    ] });
  });

  it('sets permissions before publishing so post-rename chmod cannot report write failure', async () => {
    const { filePath } = await makeStore();
    await fs.writeFile(filePath, JSON.stringify({ version: 3, acknowledgements: [] }), { mode: 0o600 });
    const store = createSystemPushAcknowledgementStore({
      filePath, fsImpl: { ...fs, chmod: async (target, mode) => {
        if (target === filePath) throw new Error('post-rename chmod failed');
        return fs.chmod(target, mode);
      } },
    });
    await store.acknowledge(...AUTHORITY_ONE);
    await expect(store.isAcknowledged(...AUTHORITY_ONE)).resolves.toBe(true);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it.each(['writeFile', 'chmod', 'rename'])('preserves persisted data and cleans temporary files when %s fails', async (method) => {
    const { filePath } = await makeStore();
    const original = JSON.stringify({ version: 3, acknowledgements: [] });
    await fs.writeFile(filePath, original, { mode: 0o600 });
    const failing = createSystemPushAcknowledgementStore({
      filePath, fsImpl: { ...fs, [method]: async () => { throw new Error('acknowledgement write failed'); } },
    });
    await expect(failing.acknowledge(...AUTHORITY_ONE)).rejects.toThrow('acknowledgement write failed');
    expect(await fs.readFile(filePath, 'utf8')).toBe(original);
    expect(await fs.readdir(path.dirname(filePath))).toEqual(['acknowledgements.json']);
    const store = createSystemPushAcknowledgementStore({ filePath });
    await expect(store.isAcknowledged(...AUTHORITY_ONE)).resolves.toBe(false);
    await store.acknowledge(...AUTHORITY_ONE);
    await expect(store.isAcknowledged(...AUTHORITY_ONE)).resolves.toBe(true);
  });

  it('fails closed for permissive persisted state', async () => {
    if (process.platform === 'win32') return;
    const { filePath, store } = await makeStore();
    await fs.writeFile(filePath, JSON.stringify({ version: 3, acknowledgements: [] }), { mode: 0o644 });
    await expect(store.isAcknowledged(...AUTHORITY_ONE)).rejects.toMatchObject({
      code: 'SYSTEM_PUSH_ACKNOWLEDGEMENT_STORE_INVALID',
    });
  });

  it('preserves the previous v3 state when atomic rename fails', async () => {
    const { filePath, store } = await makeStore();
    await store.acknowledge(...AUTHORITY_ONE);
    const previous = await fs.readFile(filePath, 'utf8');
    const failing = createSystemPushAcknowledgementStore({
      filePath,
      fsImpl: { ...fs, rename: async () => { throw new Error('rename failed'); } },
    });
    await expect(failing.acknowledge(...AUTHORITY_TWO)).rejects.toThrow('rename failed');
    expect(await fs.readFile(filePath, 'utf8')).toBe(previous);
    await expect(store.isAcknowledged(...AUTHORITY_TWO)).resolves.toBe(false);
  });
});
