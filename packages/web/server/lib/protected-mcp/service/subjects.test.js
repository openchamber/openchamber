import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { adminRequest, createAdminSocketClient } from '../test-support/admin-socket-client.js';
import { engineRequest, engineSession, startService } from '../test-support/fixtures.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup() {
  const fixture = await startService();
  cleanups.push(fixture.close);
  const admin = createAdminSocketClient(fixture.adminSocketPath);
  const { connection } = await admin.create({ name: 'one', transport: 'http', http: { url: 'https://example.test/mcp', headers: { Authorization: { secret: 'token' } } } }, { token: 'synthetic' });
  const { connection: other } = await admin.create({ name: 'two', transport: 'http', http: { url: 'https://example.test/mcp', oauth: { scopes: [] } } });
  return { ...fixture, admin, connection, other, request: (frame) => adminRequest(fixture.adminSocketPath, frame), socket: (subject = 'agent') => path.join(path.dirname(fixture.engineSocketPath), 'subjects', subject, 'engine.sock') };
}

it('sets, lists and removes subjects through admin frames', async () => {
  // Given an approved connection.
  const f = await setup();
  // When an administrator creates its subject grant.
  const answer = await f.request({ type: 'subject-set', subject: 'agent', connections: [f.connection.id, f.connection.id] });
  // Then the stored grant is a set and can be listed and removed.
  expect(answer).toEqual({ type: 'subject', subject: 'agent', connections: [f.connection.id] });
  expect(await f.request({ type: 'subjects' })).toEqual({ type: 'subjects', subjects: [{ subject: 'agent', connections: [f.connection.id] }] });
  expect(await f.request({ type: 'subject-remove', subject: 'agent' })).toEqual({ type: 'subject-removed', subject: 'agent' });
  expect(await f.request({ type: 'subjects' })).toEqual({ type: 'subjects', subjects: [] });
});

it.each(['', '../agent', 'space-0123456789AB', 'space-0123456789a', 'space-0123456789abc', 'Agent', 7])('refuses invalid subject %j', async (subject) => {
  // Given an administrator and a valid connection.
  const f = await setup();
  // When the subject name is invalid.
  const answer = await f.request({ type: 'subject-set', subject, connections: [f.connection.id] });
  // Then the frame grants nothing.
  expect(answer).toMatchObject({ type: 'error', code: 'invalid_subject' });
});

it.each([null, ['not-an-id'], 'all'])('refuses invalid connection sets %j', async (connections) => {
  // Given an administrator.
  const f = await setup();
  // When the connection set is malformed.
  const answer = await f.request({ type: 'subject-set', subject: 'agent', connections });
  // Then validation refuses the request.
  expect(answer).toMatchObject({ type: 'error', code: 'invalid_request' });
});

it('preserves a grant when a replacement names an unknown connection', async () => {
  // Given a persisted subject.
  const f = await setup();
  await f.request({ type: 'subject-set', subject: 'agent', connections: [f.connection.id] });
  // When a replacement names an unknown id.
  const answer = await f.request({ type: 'subject-set', subject: 'agent', connections: [f.other.id, 'pmcp_ffffffffffffffff'] });
  // Then the existing authority remains unchanged.
  expect(answer).toMatchObject({ type: 'error', code: 'unknown_connection' });
  expect((await f.request({ type: 'subjects' })).subjects).toEqual([{ subject: 'agent', connections: [f.connection.id] }]);
});

it('opens an allowed hello on the subject socket', async () => {
  // Given a subject allowing a credential-incomplete connection, which uses the real fallback backend.
  const f = await setup();
  await f.request({ type: 'subject-set', subject: 'space-0123456789ab', connections: [f.other.id] });
  const session = engineSession(f.socket('space-0123456789ab'), f.other.id);
  cleanups.push(session.close);
  // When the connection initializes through that listener.
  expect(await session.next()).toMatchObject({ type: 'ready', connection: f.other.id });
  session.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
  // Then MCP traffic reaches the backend.
  expect((await session.response(1)).message.result).toEqual({});
});

it.each(['other', 'status', 'forged-subject', 'admin'])('refuses %s on a subject listener', async (kind) => {
  // Given a subject with one grant.
  const f = await setup();
  await f.request({ type: 'subject-set', subject: 'agent', connections: [f.connection.id] });
  const frames = { other: { type: 'hello', protocol: 1, connection: f.other.id }, status: { type: 'status' }, 'forged-subject': { type: 'hello', protocol: 1, connection: f.other.id, subject: 'agent' }, admin: { type: 'subject-set', subject: 'agent', connections: [f.other.id] } };
  // When the client attempts a request outside its listener authority.
  const answer = await engineRequest(f.socket(), frames[kind]);
  // Then no status, administrative authority or other connection is exposed.
  expect(answer).toEqual([{ type: 'error', code: kind === 'other' ? 'connection_not_allowed' : kind === 'forged-subject' ? 'malformed_frame' : 'unsupported_request' }]);
});

it.each(['shrink', 'remove'])('ends only the revoked subject sessions on %s', async (kind) => {
  // Given the same connection in two subjects, plus another connection in agent.
  const f = await setup();
  const { connection: third } = await f.admin.create({ name: 'three', transport: 'http', http: { url: 'https://example.test/mcp', oauth: { scopes: [] } } });
  await f.request({ type: 'subject-set', subject: 'agent', connections: [f.other.id, third.id] });
  await f.request({ type: 'subject-set', subject: 'space-0123456789ab', connections: [f.other.id] });
  const removed = engineSession(f.socket(), f.other.id);
  const retained = engineSession(f.socket(), third.id);
  const elsewhere = engineSession(f.socket('space-0123456789ab'), f.other.id);
  cleanups.push(removed.close, retained.close, elsewhere.close);
  await Promise.all([removed.next(), retained.next(), elsewhere.next()]);
  // When one subject loses authority.
  await f.request(kind === 'shrink' ? { type: 'subject-set', subject: 'agent', connections: [third.id] } : { type: 'subject-remove', subject: 'agent' });
  // Then its removed sessions end while the other subject still answers.
  await expect(removed.next()).rejects.toThrow('session closed');
  if (kind === 'remove') await expect(retained.next()).rejects.toThrow('session closed');
  else { retained.send({ jsonrpc: '2.0', id: 1, method: 'ping' }); expect((await retained.response(1)).message.result).toEqual({}); }
  elsewhere.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
  expect((await elsewhere.response(1)).message.result).toEqual({});
});

it('removes a deleted connection from every persisted subject', async () => {
  // Given two subjects granting the same connection.
  const f = await setup();
  for (const subject of ['agent', 'space-0123456789ab']) await f.request({ type: 'subject-set', subject, connections: [f.connection.id, f.other.id] });
  // When that connection is deleted.
  await f.admin.apply({ kind: 'remove', id: f.connection.id, expectedRevision: 1 });
  // Then only the surviving grant remains on disk and over administration.
  expect((await f.request({ type: 'subjects' })).subjects.map((entry) => entry.connections)).toEqual([[f.other.id], [f.other.id]]);
  const state = JSON.parse(await fs.readFile(path.join(f.stateDir, 'state.json'), 'utf8'));
  expect(JSON.stringify(state.subjects)).not.toContain(f.connection.id);
});

it('sets private parent, searchable subject and connectable socket modes', async () => {
  // Given a service under a temporary root.
  const f = await setup();
  // When an empty subject is created.
  await f.request({ type: 'subject-set', subject: 'agent', connections: [] });
  // Then only its directory can be bound into another unit.
  const directory = path.dirname(f.socket());
  expect((await fs.stat(path.dirname(directory))).mode & 0o777).toBe(0o700);
  expect((await fs.stat(directory)).mode & 0o777).toBe(0o711);
  expect((await fs.stat(f.socket())).mode & 0o777).toBe(0o666);
});
