import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { createClientPairingRuntime } from './pairing.js';

const makeRuntime = async (options = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-pairing-test-'));
  const createdClients = [];
  const remoteClientAuthRuntime = options.remoteClientAuthRuntime || {
    createClient: vi.fn(async (input) => {
      const client = {
        id: `client-${createdClients.length + 1}`,
        label: input.label ?? input.fallbackLabel,
        clientKind: input.clientKind,
        authMethod: input.authMethod,
        pairingId: input.pairingId,
        deviceName: input.deviceName ?? null,
      };
      createdClients.push(client);
      return { client, token: `token-${createdClients.length}` };
    }),
  };
  const runtime = createClientPairingRuntime({
    fsPromises: options.fsPromises || fs,
    path,
    crypto,
    storePath: path.join(dir, 'pairing.json'),
    remoteClientAuthRuntime,
    ttlMs: options.ttlMs ?? 10 * 60 * 1000,
  });
  return { dir, runtime, remoteClientAuthRuntime, createdClients };
};

describe('client auth pairing runtime', () => {
  it('redeems a pairing session once and propagates client metadata', async () => {
    const { runtime, remoteClientAuthRuntime } = await makeRuntime();
    const created = await runtime.createPairingSession({ allowedClientKinds: ['mobile'] });

    const result = await runtime.redeemPairingSession({
      pairingId: created.pairing.id,
      secret: created.pairing.secret,
      clientLabel: 'Iryna iPhone',
      clientKind: 'mobile',
      deviceName: 'Iryna iPhone',
      dedupeKey: 'device-key',
    });

    expect(result.token).toBe('token-1');
    expect(result.client).toMatchObject({
      label: 'Iryna iPhone',
      clientKind: 'mobile',
      authMethod: 'pairing',
      pairingId: created.pairing.id,
      deviceName: 'Iryna iPhone',
    });
    expect(remoteClientAuthRuntime.createClient).toHaveBeenCalledWith(expect.objectContaining({
      authMethod: 'pairing',
      pairingId: created.pairing.id,
      clientKind: 'mobile',
      dedupeKey: 'device-key',
      // No operator-typed pairing label: the app-reported name is only a
      // fallback so a re-pair keeps the existing device record's label.
      label: null,
      fallbackLabel: 'Iryna iPhone',
    }));

    await expect(runtime.redeemPairingSession({
      pairingId: created.pairing.id,
      secret: created.pairing.secret,
      clientKind: 'mobile',
    })).rejects.toThrow('Invalid or expired pairing session');
  });

  it('rejects expired, cancelled, wrong-secret, and disallowed-kind redemption', async () => {
    const { runtime: expiredRuntime } = await makeRuntime({ ttlMs: -1000 });
    const expired = await expiredRuntime.createPairingSession();
    await expect(expiredRuntime.redeemPairingSession({
      pairingId: expired.pairing.id,
      secret: expired.pairing.secret,
      clientKind: 'mobile',
    })).rejects.toThrow('Invalid or expired pairing session');

    const { runtime } = await makeRuntime();
    const cancelled = await runtime.createPairingSession();
    await runtime.cancelPairingSession(cancelled.pairing.id);
    await expect(runtime.redeemPairingSession({
      pairingId: cancelled.pairing.id,
      secret: cancelled.pairing.secret,
      clientKind: 'mobile',
    })).rejects.toThrow('Invalid or expired pairing session');

    const wrongSecret = await runtime.createPairingSession();
    await expect(runtime.redeemPairingSession({
      pairingId: wrongSecret.pairing.id,
      secret: 'wrong',
      clientKind: 'mobile',
    })).rejects.toThrow('Invalid or expired pairing session');

    const desktopOnly = await runtime.createPairingSession({ allowedClientKinds: ['desktop'] });
    await expect(runtime.redeemPairingSession({
      pairingId: desktopOnly.pairing.id,
      secret: desktopOnly.pairing.secret,
      clientKind: 'mobile',
    })).rejects.toThrow('Invalid or expired pairing session');
  });

  it('does not consume the pairing session if client issuance fails', async () => {
    const createClient = vi.fn()
      .mockRejectedValueOnce(new Error('disk failed'))
      .mockResolvedValueOnce({ client: { id: 'client-1' }, token: 'token-1' });
    const { runtime } = await makeRuntime({ remoteClientAuthRuntime: { createClient } });
    const created = await runtime.createPairingSession();

    await expect(runtime.redeemPairingSession({
      pairingId: created.pairing.id,
      secret: created.pairing.secret,
      clientKind: 'mobile',
    })).rejects.toThrow('disk failed');

    await expect(runtime.redeemPairingSession({
      pairingId: created.pairing.id,
      secret: created.pairing.secret,
      clientKind: 'mobile',
    })).resolves.toMatchObject({ token: 'token-1' });
    expect(createClient).toHaveBeenLastCalledWith(expect.objectContaining({
      dedupeKey: `pairing:${created.pairing.id}`,
    }));
  });

  it('sweeps expired never-used sessions from the store on the next create', async () => {
    const { dir, runtime } = await makeRuntime({ ttlMs: -1000 });
    // Immediately expired (negative TTL), never used or cancelled.
    const expired = await runtime.createPairingSession({ label: 'stale' });

    // The next create sweeps the store; only the fresh session should remain.
    const storePath = path.join(dir, 'pairing.json');
    await runtime.createPairingSession({ label: 'fresh' });
    const store = JSON.parse(await fs.readFile(storePath, 'utf8'));
    const ids = store.sessions.map((session) => session.id);
    expect(ids).not.toContain(expired.pairing.id);
    expect(ids).toHaveLength(1);
  });

  it('treats sessions with missing or unparseable expiresAt as expired everywhere', async () => {
    const { dir, runtime, remoteClientAuthRuntime } = await makeRuntime();
    const storePath = path.join(dir, 'pairing.json');
    const seedSession = (id, secret, extra) => ({
      id,
      secretHash: crypto.createHash('sha256').update(secret).digest('hex'),
      createdAt: new Date().toISOString(),
      usedAt: null,
      cancelledAt: null,
      clientId: null,
      label: null,
      fingerprint: 'ABCD-1234',
      allowedClientKinds: ['mobile', 'desktop'],
      createdByClientId: null,
      usesRelay: true,
      ...extra,
    });
    await fs.writeFile(storePath, JSON.stringify({
      version: 1,
      sessions: [
        seedSession('pair_missing_expiry', 'missing-secret', {}),
        seedSession('pair_garbage_expiry', 'garbage-secret', { expiresAt: 'not-a-date' }),
      ],
    }, null, 2), 'utf8');

    // Not pending, and the relay-flagged seeds create no relay demand.
    expect(await runtime.listPendingSessions()).toEqual([]);
    expect(await runtime.hasActiveRelaySession()).toBe(false);

    // Redeem rejects both shapes with the generic error and issues no client.
    for (const [pairingId, secret] of [['pair_missing_expiry', 'missing-secret'], ['pair_garbage_expiry', 'garbage-secret']]) {
      await expect(runtime.redeemPairingSession({ pairingId, secret, clientKind: 'mobile' }))
        .rejects.toThrow('Invalid or expired pairing session');
    }
    expect(remoteClientAuthRuntime.createClient).not.toHaveBeenCalled();

    // The sweep drops both: a missing/unparseable expiry is expired, not immortal.
    await expect(runtime.sweepExpiredSessions()).resolves.toEqual({ purged: 2 });
    expect(JSON.parse(await fs.readFile(storePath, 'utf8')).sessions).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('never persists a fabricated expiry for a session whose expiresAt is missing', async () => {
    const { dir, runtime } = await makeRuntime();
    const storePath = path.join(dir, 'pairing.json');
    await fs.writeFile(storePath, JSON.stringify({
      version: 1,
      sessions: [{
        id: 'pair_no_expiry_stamp',
        secretHash: crypto.createHash('sha256').update('some-secret').digest('hex'),
        createdAt: new Date().toISOString(),
        usedAt: null,
        cancelledAt: null,
        clientId: null,
        label: null,
        fingerprint: 'ABCD-1234',
        allowedClientKinds: ['mobile', 'desktop'],
        createdByClientId: null,
        usesRelay: false,
      }],
    }, null, 2), 'utf8');

    // Cancelling rewrites the whole store through normalizeStore; the
    // session's expiresAt must round-trip as null, not a fresh TTL stamp.
    await runtime.cancelPairingSession('pair_no_expiry_stamp');
    const stored = JSON.parse(await fs.readFile(storePath, 'utf8'));
    expect(stored.sessions).toHaveLength(1);
    expect(stored.sessions[0].expiresAt).toBeNull();
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('client auth pairing store durability', () => {
  it('preserves a corrupt store instead of silently discarding every pairing session', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { dir, runtime } = await makeRuntime();
      const storePath = path.join(dir, 'pairing.json');
      const corrupt = '{"version":1,"sessions":[{"id":"pair_1"';
      await fs.writeFile(storePath, corrupt, 'utf8');

      await runtime.createPairingSession({ label: 'Phone' });

      const preserved = (await fs.readdir(dir)).filter((name) => name.includes('.corrupt-'));
      expect(preserved).toHaveLength(1);
      expect(await fs.readFile(path.join(dir, preserved[0]), 'utf8')).toBe(corrupt);
      const warnText = warnSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
      expect(warnText).toContain(preserved[0]);
      // The new session landed in a fresh, valid store file.
      expect(JSON.parse(await fs.readFile(storePath, 'utf8')).sessions).toHaveLength(1);
      await fs.rm(dir, { recursive: true, force: true });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not preserve a live replacement when its own read was stale', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { dir, runtime } = await makeRuntime();
      const storePath = path.join(dir, 'pairing.json');
      await runtime.createPairingSession({ label: 'Phone' });

      // A second runtime (the CLI process shape) whose first read returns
      // a stale corrupt snapshot while the file on disk is already the
      // valid store written above: acting on that snapshot would rename
      // the live session away (Codex, PR #890).
      let stalePending = true;
      const staleRuntime = createClientPairingRuntime({
        fsPromises: {
          ...fs,
          readFile: async (target, ...rest) => {
            if (stalePending && String(target) === storePath) {
              stalePending = false;
              return '{"version":1,"sessions":[{"id":"pair_stale"';
            }
            return fs.readFile(target, ...rest);
          },
        },
        path,
        crypto,
        storePath,
        remoteClientAuthRuntime: { createClient: vi.fn(async () => { throw new Error('not used'); }) },
        ttlMs: 10 * 60 * 1000,
      });

      const pending = await staleRuntime.listPendingSessions();
      expect(pending).toHaveLength(1);
      expect((await fs.readdir(dir)).filter((name) => name.includes('.corrupt-'))).toEqual([]);
      expect(JSON.parse(await fs.readFile(storePath, 'utf8')).sessions).toHaveLength(1);
      await fs.rm(dir, { recursive: true, force: true });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('revalidates an empty snapshot before treating the store as missing (Codex, PR #1019)', async () => {
    const { dir, runtime } = await makeRuntime();
    const storePath = path.join(dir, 'pairing.json');
    await runtime.createPairingSession({ label: 'Phone' });

    // First read returns empty bytes (a torn/empty snapshot) while the
    // file on disk already holds the valid store written above: treating
    // that snapshot as a missing store would let the next mutation
    // overwrite the live session.
    let emptyPending = true;
    const emptyReadRuntime = createClientPairingRuntime({
      fsPromises: {
        ...fs,
        readFile: async (target, ...rest) => {
          if (emptyPending && String(target) === storePath) {
            emptyPending = false;
            return '';
          }
          return fs.readFile(target, ...rest);
        },
      },
      path,
      crypto,
      storePath,
      remoteClientAuthRuntime: { createClient: vi.fn(async () => { throw new Error('not used'); }) },
      ttlMs: 10 * 60 * 1000,
    });

    await emptyReadRuntime.createPairingSession({ label: 'Tablet' });
    expect(JSON.parse(await fs.readFile(storePath, 'utf8')).sessions).toHaveLength(2);
    expect((await fs.readdir(dir)).filter((name) => name.includes('.corrupt-'))).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes via a temp file renamed into place, and a failed rename leaves the previous store intact', async () => {
    const writeTargets = [];
    const renameCalls = [];
    let failRename = false;
    const fsOverrides = {
      ...fs,
      writeFile: async (target, ...rest) => {
        writeTargets.push(String(target));
        return fs.writeFile(target, ...rest);
      },
      rename: async (from, to) => {
        renameCalls.push([String(from), String(to)]);
        if (failRename) throw new Error('rename failed');
        return fs.rename(from, to);
      },
    };
    const { dir, runtime } = await makeRuntime({ fsPromises: fsOverrides });
    const storePath = path.join(dir, 'pairing.json');

    await runtime.createPairingSession({ label: 'Phone' });
    expect(writeTargets.length).toBeGreaterThan(0);
    expect(writeTargets).not.toContain(storePath);
    expect(writeTargets.every((target) => target.startsWith(`${storePath}.tmp-`))).toBe(true);
    expect(renameCalls).toEqual(writeTargets.map((target) => [target, storePath]));
    expect(await fs.readdir(dir)).toEqual(['pairing.json']);

    const before = await fs.readFile(storePath, 'utf8');
    failRename = true;
    await expect(runtime.createPairingSession({ label: 'Tablet' })).rejects.toThrow('rename failed');
    expect(await fs.readFile(storePath, 'utf8')).toBe(before);
    expect(await fs.readdir(dir)).toEqual(['pairing.json']);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('cuts a pairing label that straddles the 80-char cap at the surrogate pair boundary', async () => {
    const { dir, runtime } = await makeRuntime();
    const created = await runtime.createPairingSession({ label: `${'d'.repeat(79)}\u{1F600}x` });
    expect(created.pairing.label).toBe('d'.repeat(79));
    expect(created.pairing.label.isWellFormed()).toBe(true);
    expect(Buffer.from(created.pairing.label, 'utf8').toString('utf8')).toBe(created.pairing.label);

    const ascii = await runtime.createPairingSession({ label: 'b'.repeat(120) });
    expect(ascii.pairing.label).toBe('b'.repeat(80));
    await fs.rm(dir, { recursive: true, force: true });
  });
});
