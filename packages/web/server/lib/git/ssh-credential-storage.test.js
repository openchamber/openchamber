import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createManagedSshCredentialStore } from './ssh-credential-storage.js';
import { gitStorageProcess } from './storage-process.test-support.js';

const directories = [];
const children = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.stop()));
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('managed SSH credential storage', () => {
  it('fails reads and replacements while another process owns the snapshot lock', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-ssh-store-lock-'));
    directories.push(directory);
    const filePath = path.join(directory, 'git-ssh-credentials.json');
    const owner = await gitStorageProcess('ssh', filePath);
    children.push(owner);
    owner.call('hold-lock');
    await expect.poll(() => owner.events.some((event) => event.event === 'locked')).toBe(true);
    const store = createManagedSshCredentialStore({ filePath, lockWaitMs: 20 });
    await expect(store.read()).rejects.toMatchObject({ code: 'SOURCE_CONTROL_LOCK_BUSY', status: 503 });
    await expect(store.replace([])).rejects.toMatchObject({ code: 'SOURCE_CONTROL_LOCK_BUSY', status: 503 });
    await expect(store.append({ id: 'one', privateKeyPath: '/secure/key', fingerprint: `SHA256:${'a'.repeat(43)}` }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_LOCK_BUSY', status: 503 });
  });

  it('reads one exact versioned mode-0600 pre-provisioned key record', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-ssh-store-'));
    directories.push(directory);
    const filePath = path.join(directory, 'git-ssh-credentials.json');
    const record = { id: 'deploy-one', privateKeyPath: '/secure/key', fingerprint: `SHA256:${'a'.repeat(43)}` };
    await fs.writeFile(filePath, JSON.stringify({ version: 1, keys: [record] }), { mode: 0o600 });
    const store = createManagedSshCredentialStore({ filePath });

    await expect(store.lookup('deploy-one')).resolves.toEqual(record);
    await expect(store.lookup('missing')).resolves.toBeNull();
  });

  it('atomically replaces records with mode 0600', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-ssh-store-write-'));
    directories.push(directory);
    const filePath = path.join(directory, 'git-ssh-credentials.json');
    const store = createManagedSshCredentialStore({ filePath });
    const record = { id: 'deploy-one', privateKeyPath: '/secure/key', fingerprint: `SHA256:${'a'.repeat(43)}` };

    await store.replace([record]);

    await expect(store.lookup('deploy-one')).resolves.toEqual(record);
    if (process.platform !== 'win32') expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('appends under one lock without dropping existing records and enforces capacity', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-ssh-store-append-'));
    directories.push(directory);
    const filePath = path.join(directory, 'git-ssh-credentials.json');
    const store = createManagedSshCredentialStore({ filePath });
    const first = { id: 'first', privateKeyPath: '/secure/first', fingerprint: `SHA256:${'a'.repeat(43)}` };
    const second = { id: 'second', privateKeyPath: '/secure/second', fingerprint: `SHA256:${'b'.repeat(43)}` };
    await store.replace([first]);

    await expect(store.append(second, { maxKeys: 2 })).resolves.toMatchObject({ keys: [first, second] });
    await expect(store.append({ ...second, id: 'third' }, { maxKeys: 2 }))
      .rejects.toMatchObject({ code: 'MANAGED_SSH_CREDENTIAL_LIMIT' });
    await expect(store.read()).resolves.toMatchObject({ keys: [first, second] });
  });

  it('marks a record committed when atomic replacement succeeds but lock cleanup fails', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-ssh-store-committed-'));
    directories.push(directory);
    const filePath = path.join(directory, 'git-ssh-credentials.json');
    const fsImpl = { ...fs, unlink: async (target) => {
      if (target === `${filePath}.lock`) throw new Error('unlock denied');
      return fs.unlink(target);
    } };
    const store = createManagedSshCredentialStore({ filePath, fsImpl });
    const record = { id: 'committed', privateKeyPath: '/secure/key', fingerprint: `SHA256:${'c'.repeat(43)}` };

    await expect(store.append(record)).rejects.toMatchObject({ managedSshRecordCommitted: true });
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toEqual({ version: 1, keys: [record] });
  });

  it('rejects permissive mode and unknown persisted fields', async () => {
    if (process.platform === 'win32') return;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-ssh-store-invalid-'));
    directories.push(directory);
    const filePath = path.join(directory, 'git-ssh-credentials.json');
    await fs.writeFile(filePath, JSON.stringify({ version: 1, keys: [] }), { mode: 0o644 });
    const store = createManagedSshCredentialStore({ filePath });
    await expect(store.read()).rejects.toMatchObject({ code: 'INVALID_MANAGED_SSH_CREDENTIAL_STORE' });

    await fs.writeFile(filePath, JSON.stringify({ version: 1, keys: [], token: 'nope' }), { mode: 0o600 });
    await expect(store.read()).rejects.toMatchObject({ code: 'INVALID_MANAGED_SSH_CREDENTIAL_STORE' });
  });
});
