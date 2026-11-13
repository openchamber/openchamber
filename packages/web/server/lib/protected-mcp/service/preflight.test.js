import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createIntegrity } from './integrity.js';
import { runPreflight } from './preflight.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pmcp-preflight-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const socket = path.join(root, 'admin.sock');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(socket, resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return socket;
}

describe('administration separation', () => {
  it.each([
    [0o600, 'other', [], 'separate'], [0o660, 'group', [], 'shared'],
    [0o600, 'owner', [], 'shared'], [0o602, 'other', [], 'shared'],
    [0o600, 'other', ['user:2000000002:rw-'], 'shared'],
    [0o600, 'other', null, 'shared'],
  ])('reports mode %s, identity %s and ACL %j without changing enforcement', async (mode, identity, acl, administration) => {
    // Given
    const socket = await setup();
    await fs.chmod(socket, mode);
    const engine = { uid: identity === 'owner' ? process.getuid() : 2_000_000_002, gids: [identity === 'group' ? process.getgid() : 2_000_000_002] };
    const integrity = createIntegrity({ owners: [0, process.getuid()], engine, readAcl: async () => acl });
    // When
    const result = await runPreflight({ integrity, engine, engineUser: 'engine', adminSocket: socket, trustedPaths: [], privateDirectories: [], sockets: [], readGroups: async () => '' });
    // Then
    expect(result).toMatchObject({ administration, status: 'protected', findings: [] });
  });

  it.each(['missing', 'unreadable', 'unset'])('reports shared when administration is %s', async (condition) => {
    // Given
    const socket = await setup();
    await fs.chmod(socket, 0o600);
    const engine = { uid: 2_000_000_002, gids: [2_000_000_002] };
    const integrity = createIntegrity({ owners: [0, process.getuid()], engine, readAcl: async () => { throw new Error('unreadable'); } });
    // When
    const result = await runPreflight({ integrity, engine, engineUser: 'engine', adminSocket: condition === 'unset' ? null : condition === 'missing' ? `${socket}.missing` : socket, trustedPaths: [], privateDirectories: [], sockets: [], readGroups: async () => '' });
    // Then
    expect(result).toMatchObject({ administration: 'shared', status: 'protected', findings: [] });
  });
});
