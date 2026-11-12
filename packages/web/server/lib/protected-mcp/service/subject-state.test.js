import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { adminRequest, createAdminSocketClient } from '../test-support/admin-socket-client.js';
import { engineRequest, engineSession, startService } from '../test-support/fixtures.js';
import { createProtectedMcpService } from './service.js';
import { openStore } from './store.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup() {
  const f = await startService();
  cleanups.push(f.close);
  const admin = createAdminSocketClient(f.adminSocketPath);
  const { connection } = await admin.create({ name: 'one', transport: 'http', http: { url: 'https://example.test/mcp', oauth: { scopes: [] } } });
  const request = (frame) => adminRequest(f.adminSocketPath, frame);
  await request({ type: 'subject-set', subject: 'agent', connections: [connection.id] });
  return { ...f, connection, admin, request, directory: path.join(path.dirname(f.engineSocketPath), 'subjects', 'agent') };
}

it('preserves the directory inode and subject authority across a new service instance', async () => {
  // Given a persisted subject directory, as held by a bind mount in another unit.
  const f = await setup();
  const inode = (await fs.stat(f.directory)).ino;
  await f.service.close();
  const next = await createProtectedMcpService({ version: 'test', stateDir: f.stateDir, engineSocketPath: f.engineSocketPath, adminSocketPath: f.adminSocketPath, integrity: { owners: [process.getuid()], engine: { uid: 2_000_000_002, gids: [] } }, enforcement: async () => ({ status: 'protected', checkedAt: 0, findings: [] }) });
  cleanups.push(next.close);
  // When a fresh process-equivalent service starts over the same state and runtime directories.
  await next.start();
  // Then the same directory leads to the newly created socket and the persisted grant.
  expect((await fs.stat(f.directory)).ino).toBe(inode);
  const session = engineSession(path.join(f.directory, 'engine.sock'), f.connection.id);
  cleanups.push(session.close);
  expect(await session.next()).toMatchObject({ type: 'ready', connection: f.connection.id });
  expect((await f.request({ type: 'subjects' })).subjects).toEqual([{ subject: 'agent', connections: [f.connection.id] }]);
});

it('preserves the subject directory inode through replacement, removal and recreation', async () => {
  // Given an existing directory.
  const f = await setup();
  const inode = (await fs.stat(f.directory)).ino;
  // When the grant is emptied, removed and created again.
  await f.request({ type: 'subject-set', subject: 'agent', connections: [] });
  await f.request({ type: 'subject-remove', subject: 'agent' });
  await f.request({ type: 'subject-set', subject: 'agent', connections: [f.connection.id] });
  // Then existing directory binds keep their target.
  expect((await fs.stat(f.directory)).ino).toBe(inode);
});

it.each(['subject-set', 'subject-remove', 'connection-remove'])('keeps authority and active sessions when %s cannot persist', async (type) => {
  // Given a valid snapshot and a filesystem condition that refuses its atomic replacement.
  const f = await setup();
  const file = path.join(f.stateDir, 'state.json');
  await fs.rename(file, `${file}.saved`);
  await fs.mkdir(file);
  cleanups.push(async () => { await fs.rmdir(file); await fs.rename(`${file}.saved`, file); });
  const session = engineSession(path.join(f.directory, 'engine.sock'), f.connection.id);
  cleanups.push(session.close);
  await session.next();
  // When a destructive change cannot commit.
  const answer = await f.request(type === 'connection-remove' ? { type: 'apply', operation: { kind: 'remove', id: f.connection.id, expectedRevision: 1 } } : { type, subject: 'agent', connections: [] });
  // Then the previous grant and session remain valid, without a partial revocation.
  expect(answer).toMatchObject({ type: 'error', code: 'internal_error' });
  expect((await f.request({ type: 'subjects' })).subjects).toEqual([{ subject: 'agent', connections: [f.connection.id] }]);
  session.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
  expect((await session.response(1)).message.result).toEqual({});
});

it('leaves stage 1 status and unrestricted hello behavior intact', async () => {
  // Given a connection absent from agent's allowed set.
  const f = await setup();
  await f.request({ type: 'subject-set', subject: 'agent', connections: [] });
  // When a client uses the original group socket.
  const [status] = await engineRequest(f.engineSocketPath, { type: 'status' });
  const session = engineSession(f.engineSocketPath, f.connection.id);
  cleanups.push(session.close);
  // Then stage 1 still grants every connection and status.
  expect(status.connections.map((connection) => connection.id)).toContain(f.connection.id);
  expect(await session.next()).toMatchObject({ type: 'ready', connection: f.connection.id });
});

it('accepts stage 1 snapshots without a subjects field', async () => {
  // Given a snapshot from before subject support.
  const f = await setup();
  await f.service.close();
  const file = path.join(f.stateDir, 'state.json');
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  delete state.subjects;
  await fs.writeFile(file, JSON.stringify(state));
  // When the new store opens it.
  const store = await openStore({ stateDir: f.stateDir });
  cleanups.push(store.close);
  // Then no migration grants authority implicitly.
  expect(store.subjects()).toEqual([]);
  expect(store.get(f.connection.id).id).toBe(f.connection.id);
});
