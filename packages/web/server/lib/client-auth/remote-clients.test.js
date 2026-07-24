import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRemoteClientAuthRuntime } from './remote-clients.js';

const createRuntime = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-remote-clients-test-'));
  const storePath = path.join(dir, 'remote-clients.json');
  const runtime = createRemoteClientAuthRuntime({
    fsPromises: fs,
    path,
    crypto,
    storePath,
  });
  return { dir, runtime, storePath };
};

describe('remote client auth runtime', () => {
  it('creates, authenticates, lists, and revokes client tokens', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      const created = await runtime.createClient({ label: 'Laptop' });
      expect(created.token.startsWith('oc_client_')).toBe(true);
      expect(created.client.label).toBe('Laptop');
      expect(created.client.capabilities).toEqual(['workspace.read', 'workspace.use']);

      const listed = await runtime.listClients();
      expect(listed).toHaveLength(1);
      expect(listed[0].id).toBe(created.client.id);
      expect('tokenHash' in listed[0]).toBe(false);

      const authenticated = await runtime.authenticateBearerToken(created.token);
      expect(authenticated?.ok).toBe(true);
      expect(authenticated?.clientId).toBe(created.client.id);

      const afterUse = await runtime.listClients();
      expect(typeof afterUse[0].lastUsedAt).toBe('string');

      const revoked = await runtime.revokeClient(created.client.id);
      expect(revoked.revoked).toBe(true);
      expect(await runtime.authenticateBearerToken(created.token)).toBe(null);

      const purged = await runtime.purgeRevokedClients();
      expect(purged.purged).toBe(1);
      expect(await runtime.listClients()).toHaveLength(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('persists validated capability grants and rejects unknown capabilities', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      const created = await runtime.createClient({ label: 'Laptop' });
      const updated = await runtime.updateClientCapabilities(created.client.id, { grant: ['workspace.admin', 'host.apply'] });
      expect(updated.client.capabilities).toEqual(['workspace.read', 'workspace.use', 'workspace.admin', 'host.apply']);
      expect((await runtime.authenticateBearerToken(created.token))?.client.capabilities).toEqual(updated.client.capabilities);
      await expect(runtime.updateClientCapabilities(created.client.id, { grant: ['unknown'] })).rejects.toThrow('Invalid remote client capability');

      const stored = JSON.parse(await fs.readFile(path.join(dir, 'remote-clients.json'), 'utf8'));
      stored.clients[0].capabilities.push('host.shell');
      await fs.writeFile(path.join(dir, 'remote-clients.json'), JSON.stringify(stored));
      expect((await runtime.listClients())[0].capabilities).not.toContain('host.shell');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('grants local desktop authority only to native-attested records', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      const legacy = await runtime.createClient({ label: 'Legacy Desktop', clientKind: 'desktop-local' });
      expect(legacy.client.capabilities).toEqual(['workspace.read', 'workspace.use']);
      expect(legacy.client.clientKind).toBe(null);
      const desktop = await runtime.createNativeDesktopClient({ label: 'Desktop', capabilities: [] });
      expect(desktop.client.capabilities).toEqual(['workspace.read', 'workspace.use', 'workspace.admin', 'host.apply']);
      await expect(runtime.updateClientCapabilities(desktop.client.id, { revoke: ['host.apply'] })).rejects.toThrow('Native desktop client capabilities are immutable');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('demotes persisted desktop-local records without native attestation', async () => {
    const { dir, runtime, storePath } = await createRuntime();
    try {
      await fs.writeFile(storePath, JSON.stringify({
        version: 2,
        clients: [{
          id: 'forged-desktop',
          label: 'Legacy Desktop',
          tokenHash: '0'.repeat(64),
          clientKind: 'desktop-local',
          authMethod: 'native-electron',
          capabilities: ['workspace.read', 'workspace.use', 'workspace.admin', 'host.apply'],
        }],
      }));

      const [client] = await runtime.listClients();
      expect(client.clientKind).toBe(null);
      expect(client.capabilities).toEqual(['workspace.read', 'workspace.use']);

      const stored = JSON.parse(await fs.readFile(storePath, 'utf8'));
      expect(stored.clients[0].clientKind).toBe(null);
      expect(stored.clients[0].capabilities).toEqual(['workspace.read', 'workspace.use']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does not let remote clients replace the reserved desktop identity', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      const desktop = await runtime.createNativeDesktopClient({ label: 'Desktop' });

      await expect(runtime.createClient({ label: 'Forged', dedupeKey: 'desktop-local' })).rejects.toThrow('Desktop local client identity is reserved');
      const markerOnly = await runtime.createClient({ label: 'Marker only', clientKind: 'desktop-local', authMethod: 'native-electron' });
      expect(markerOnly.client.clientKind).toBe(null);
      expect((await runtime.authenticateBearerToken(desktop.token))?.client.id).toBe(desktop.client.id);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed without overwriting a malformed credential store', async () => {
    const { dir, runtime, storePath } = await createRuntime();
    try {
      await fs.writeFile(storePath, '{broken');
      await expect(runtime.listClients()).rejects.toThrow('Remote client credential store is corrupt');
      await expect(runtime.createClient({ label: 'Replacement' })).rejects.toThrow('Remote client credential store is corrupt');
      expect(await fs.readFile(storePath, 'utf8')).toBe('{broken');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on structurally invalid or unsupported credential stores', async () => {
    const invalidStores = [
      {},
      { version: 2, clients: null },
      { version: 999, clients: [] },
      { version: 2, clients: [{ id: 'client-1', tokenHash: 'invalid' }] },
    ];
    for (const payload of invalidStores) {
      const { dir, runtime, storePath } = await createRuntime();
      try {
        const serialized = JSON.stringify(payload);
        await fs.writeFile(storePath, serialized);
        await expect(runtime.listClients()).rejects.toThrow('Remote client credential store is corrupt');
        expect(await fs.readFile(storePath, 'utf8')).toBe(serialized);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('preserves the previous credential store when atomic replacement fails', async () => {
    const { dir, runtime, storePath } = await createRuntime();
    try {
      const original = await runtime.createClient({ label: 'Original' });
      const before = await fs.readFile(storePath, 'utf8');
      const failingRuntime = createRemoteClientAuthRuntime({
        fsPromises: new Proxy(fs, {
          get(target, property) {
            if (property === 'rename') return async () => { throw new Error('rename failed'); };
            return Reflect.get(target, property);
          },
        }),
        path,
        crypto,
        storePath,
      });

      await expect(failingRuntime.createClient({ label: 'Unpublished' })).rejects.toThrow('rename failed');
      expect(await fs.readFile(storePath, 'utf8')).toBe(before);
      expect((await runtime.authenticateBearerToken(original.token))?.client.id).toBe(original.client.id);
      expect((await fs.readdir(dir)).some((entry) => entry.includes('.tmp-'))).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects expired client tokens', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      const expired = await runtime.createClient({ label: 'Expired', expiresAt: '2000-01-01T00:00:00.000Z' });
      expect(expired.client.expiresAt).toBe('2000-01-01T00:00:00.000Z');
      expect(await runtime.authenticateBearerToken(expired.token)).toBe(null);

      const active = await runtime.createClient({ label: 'Active', expiresAt: '2999-01-01T00:00:00.000Z' });
      const authenticated = await runtime.authenticateBearerToken(active.token);
      expect(authenticated?.ok).toBe(true);
      expect(authenticated?.clientId).toBe(active.client.id);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps one client per dedupe key', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      const first = await runtime.createNativeDesktopClient({ label: 'Desktop' });
      const second = await runtime.createNativeDesktopClient({ label: 'Desktop' });

      expect(await runtime.authenticateBearerToken(first.token)).toBe(null);
      const authenticated = await runtime.authenticateBearerToken(second.token);
      expect(authenticated?.ok).toBe(true);

      const listed = await runtime.listClients();
      expect(listed).toHaveLength(1);
      expect(listed[0].id).toBe(second.client.id);
      expect(listed[0].clientKind).toBe('desktop-local');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the token store private on disk', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      await runtime.createClient({ label: 'Laptop' });
      const stat = await fs.stat(path.join(dir, 'remote-clients.json'));
      expect(stat.mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does not resurrect revoked clients after concurrent auth traffic', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      const created = await runtime.createClient({ label: 'Laptop' });
      await Promise.all([
        ...Array.from({ length: 20 }, () => runtime.authenticateBearerToken(created.token)),
        runtime.revokeClient(created.client.id),
      ]);

      expect(await runtime.authenticateBearerToken(created.token)).toBe(null);
      const clients = await runtime.listClients();
      expect(clients).toHaveLength(1);
      expect(typeof clients[0].revokedAt).toBe('string');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
