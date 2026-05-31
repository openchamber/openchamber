import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRemoteClientAuthRuntime } from './remote-clients.js';

const createRuntime = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-remote-clients-test-'));
  const runtime = createRemoteClientAuthRuntime({
    fsPromises: fs,
    path,
    crypto,
    storePath: path.join(dir, 'remote-clients.json'),
  });
  return { dir, runtime };
};

describe('remote client auth runtime', () => {
  it('creates, authenticates, lists, and revokes client tokens', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      const created = await runtime.createClient({ label: 'Laptop' });
      expect(created.token.startsWith('oc_client_')).toBe(true);
      expect(created.client.label).toBe('Laptop');

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
});
