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

  it('keeps one client per dedupe key', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      const first = await runtime.createClient({ label: 'Desktop', clientKind: 'desktop-local', dedupeKey: 'desktop-local' });
      const second = await runtime.createClient({ label: 'Desktop', clientKind: 'desktop-local', dedupeKey: 'desktop-local' });

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

  it('keeps the replaced record label on a dedupe re-mint without an explicit label', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      await runtime.createClient({ label: 'Iryna iPhone', dedupeKey: 'mobile:device-1', fallbackLabel: 'OpenChamber Mobile' });
      const remint = await runtime.createClient({ dedupeKey: 'mobile:device-1', fallbackLabel: 'OpenChamber Mobile' });
      expect(remint.client.label).toBe('Iryna iPhone');

      const renamed = await runtime.createClient({ label: 'Work phone', dedupeKey: 'mobile:device-1', fallbackLabel: 'OpenChamber Mobile' });
      expect(renamed.client.label).toBe('Work phone');

      const fresh = await runtime.createClient({ dedupeKey: 'mobile:device-2', fallbackLabel: 'OpenChamber Mobile' });
      expect(fresh.client.label).toBe('OpenChamber Mobile');
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

  it('self-heals usesRelay when a request arrives through the relay tunnel', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      // Pairing-time snapshot said "no relay" (pre-pairing-v2 record, or a QR
      // without a relay candidate).
      const created = await runtime.createClient({ label: 'Phone' });
      expect(created.client.usesRelay).toBe(false);
      expect(await runtime.hasActiveRelayClients()).toBe(false);

      // A tunneled request is the authoritative proof the device uses the relay.
      const relayReq = { headers: { 'x-openchamber-relay-connection': 'conn-1' } };
      const authenticated = await runtime.authenticateBearerToken(created.token, relayReq);
      expect(authenticated?.ok).toBe(true);
      expect(authenticated?.client.usesRelay).toBe(true);
      expect(await runtime.hasActiveRelayClients()).toBe(true);

      // Sticky: a later direct request must not clear relay demand.
      await runtime.authenticateBearerToken(created.token, { headers: {} });
      const listed = await runtime.listClients();
      expect(listed[0].usesRelay).toBe(true);
      expect(listed[0].lastTransport).toBe('direct');
      expect(await runtime.hasActiveRelayClients()).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('counts an observed relay transport as relay demand even without the pairing flag', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      const created = await runtime.createClient({ label: 'Tablet' });
      // Simulate a store written by a build that tracked lastTransport but not
      // the healed usesRelay flag.
      const storePath = path.join(dir, 'remote-clients.json');
      const store = JSON.parse(await fs.readFile(storePath, 'utf8'));
      store.clients[0].lastTransport = 'relay';
      await fs.writeFile(storePath, JSON.stringify(store));
      expect(created.client.usesRelay).toBe(false);
      expect(await runtime.hasActiveRelayClients()).toBe(true);
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
