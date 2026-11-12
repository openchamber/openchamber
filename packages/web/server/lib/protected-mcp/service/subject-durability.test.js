import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { adminRequest, createAdminSocketClient } from '../test-support/admin-socket-client.js';
import { engineRequest, engineSession, startService } from '../test-support/fixtures.js';

const cleanups = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup() {
  const f = await startService();
  cleanups.push(f.close);
  const admin = createAdminSocketClient(f.adminSocketPath);
  const { connection } = await admin.create({ name: 'one', transport: 'http', http: { url: 'https://example.test/mcp', oauth: { scopes: [] } } });
  const request = (frame) => adminRequest(f.adminSocketPath, frame);
  return { ...f, admin, connection, request, socket: path.join(path.dirname(f.engineSocketPath), 'subjects', 'agent', 'engine.sock') };
}

/** The OS cannot deterministically produce a directory-fsync error after a successful rename. */
function failDirectorySync(directory) {
  const open = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === directory && args[1] === 'r') vi.spyOn(handle, 'sync').mockRejectedValueOnce(Object.assign(new Error('synthetic fsync failure'), { code: 'EIO' }));
    return handle;
  });
}

it.each(['subject-set', 'subject-remove', 'connection-remove'])('keeps live revocation aligned with disk when %s commits before fsync fails', async (type) => {
  // Given a live session and a synthetic failure only at the post-rename durability flush.
  const f = await setup();
  await f.request({ type: 'subject-set', subject: 'agent', connections: [f.connection.id] });
  const session = engineSession(f.socket, f.connection.id);
  cleanups.push(session.close);
  await session.next();
  failDirectorySync(f.stateDir);
  // When the destructive snapshot replacement succeeds but its flush fails.
  const answer = await f.request(type === 'connection-remove' ? { type: 'apply', operation: { kind: 'remove', id: f.connection.id, expectedRevision: 1 } } : { type, subject: 'agent', connections: [] });
  // Then the error distinguishes a committed write and the revoked session is already ended.
  expect(answer).toMatchObject({ type: 'error', code: 'state_durability_unverified', status: 500 });
  await expect(async () => { for (;;) await session.next(); }).rejects.toThrow('session closed');
  const expected = type === 'subject-remove' ? [] : [{ subject: 'agent', connections: [] }];
  expect((await f.request({ type: 'subjects' })).subjects).toEqual(expected);
  expect(JSON.parse(await fs.readFile(path.join(f.stateDir, 'state.json'), 'utf8')).subjects).toEqual(expected);
  if (type === 'subject-remove') await expect(engineRequest(f.socket, { type: 'status' })).rejects.toMatchObject({ code: expect.stringMatching(/ENOENT|ECONNREFUSED/) });
  if (type === 'connection-remove') expect((await f.admin.get(f.connection.id)).code).toBe('connection_not_found');
});

it('keeps a committed new subject listener when the post-rename flush fails', async () => {
  // Given a connection and no subject listener yet.
  const f = await setup();
  failDirectorySync(f.stateDir);
  // When creation commits before its directory fsync fails.
  const answer = await f.request({ type: 'subject-set', subject: 'agent', connections: [f.connection.id] });
  // Then the refusal reports durability uncertainty while the committed listener and grant remain usable.
  expect(answer).toMatchObject({ type: 'error', code: 'state_durability_unverified' });
  const session = engineSession(f.socket, f.connection.id);
  cleanups.push(session.close);
  expect(await session.next()).toMatchObject({ type: 'ready', connection: f.connection.id });
  expect((await f.request({ type: 'subjects' })).subjects).toEqual([{ subject: 'agent', connections: [f.connection.id] }]);
});
